import { AuctionModel, BidModel } from '../models';
import { AuctionService } from '../modules/auctions/service';
import { LedgerService } from '../modules/ledger/service';
import { decToString } from '../shared/decimal';

type Strategy = 'calm' | 'aggressive';

function envTruthy(v: string | undefined): boolean {
  if (!v) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

function envNum(name: string, fallback: number, { min, max }: { min?: number; max?: number } = {}): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  const lo = min == null ? n : Math.max(min, n);
  const hi = max == null ? lo : Math.min(max, lo);
  return hi;
}

function pickStrategy(raw: unknown, fallback: Strategy): Strategy {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'aggressive') return 'aggressive';
  if (v === 'calm') return 'calm';
  return fallback;
}

function randInt(minIncl: number, maxIncl: number): number {
  const min = Math.ceil(minIncl);
  const max = Math.floor(maxIncl);
  return Math.floor(min + Math.random() * (max - min + 1));
}

type EffectiveAuctionCfg = {
  enabled: boolean;
  count: number;
  tickMs: number;
  strategy: Strategy;
};

type ManagerCfg = {
  defaultEnabled: boolean;
  defaultCount: number;
  defaultTickMs: number;
  defaultStrategy: Strategy;
  defaultDepositAmount: number;
  scanMs: number;
};

function loadManagerCfg(): ManagerCfg {
  const defaultEnabled = envTruthy(process.env.BOTS_AUTOSTART);
  const defaultCount = envNum('BOTS_AUTOSTART_COUNT', 20, { min: 1, max: 500 });
  const defaultTickMs = envNum('BOTS_AUTOSTART_TICK_MS', 900, { min: 50, max: 60_000 });
  const defaultStrategy = pickStrategy(process.env.BOTS_AUTOSTART_STRATEGY, 'calm');
  const defaultDepositAmount = envNum('BOTS_AUTOSTART_DEPOSIT', 100_000, { min: 1, max: 1_000_000_000 });
  const scanMs = envNum('BOTS_AUTOSTART_SCAN_MS', 1_500, { min: 250, max: 60_000 });
  return { defaultEnabled, defaultCount, defaultTickMs, defaultStrategy, defaultDepositAmount, scanMs };
}

function effectiveCfgFromAuction(doc: any, m: ManagerCfg): EffectiveAuctionCfg {
  const ap = (doc?.autoParticipants ?? {}) as any;
  const enabled = typeof ap.enabled === 'boolean' ? ap.enabled : m.defaultEnabled;
  const count = typeof ap.count === 'number' ? ap.count : m.defaultCount;
  const tickMs = typeof ap.tickMs === 'number' ? ap.tickMs : m.defaultTickMs;
  const strategy = pickStrategy(ap.strategy, m.defaultStrategy);
  return {
    enabled,
    count: Math.max(1, Math.min(500, Math.floor(count))),
    tickMs: Math.max(50, Math.min(60_000, Math.floor(tickMs))),
    strategy,
  };
}

class AuctionAutoParticipantsRunner {
  private timer: NodeJS.Timeout | null = null;
  private inflight = 0;
  private lastEnsureAt = 0;
  private participantIds: string[] = [];

  constructor(
    private readonly auctionId: string,
    private cfg: EffectiveAuctionCfg,
    private readonly defaults: Pick<ManagerCfg, 'defaultDepositAmount'>,
    private readonly service: AuctionService,
    private readonly ledger: LedgerService
  ) {}

  /**
   * Проверяет, является ли participantId ботом.
   * Боты создаются с префиксом "ap-"
   */
  private isBot(participantId: string): boolean {
    return String(participantId).startsWith('ap-');
  }


  start() {
    this.stop();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.cfg.tickMs);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  updateCfg(next: EffectiveAuctionCfg) {
    const changed = next.tickMs !== this.cfg.tickMs || next.count !== this.cfg.count || next.strategy !== this.cfg.strategy;
    this.cfg = next;
    if (changed) this.start();
  }

  private buildParticipants() {
    this.participantIds = Array.from({ length: this.cfg.count }, (_v, i) => `ap-${this.auctionId}-${i + 1}`);
  }

  private async ensureParticipants(currency: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastEnsureAt < 10_000) return; // не чаще 10с
    this.lastEnsureAt = now;

    if (this.participantIds.length !== this.cfg.count) this.buildParticipants();

    // депозит делаем best-effort и идемпотентно
    await Promise.all(
      this.participantIds.map(async (pid) => {
        const txId = `auto:${this.auctionId}:${pid}:deposit:v1`;
        try {
          await this.ledger.deposit(pid, this.defaults.defaultDepositAmount, currency, txId);
        } catch {
          // ignore
        }
      })
    );
  }

  private async bidOnce() {
    if (this.participantIds.length !== this.cfg.count) this.buildParticipants();
    const pid = this.participantIds[randInt(0, this.participantIds.length - 1)]!;

    const [auctionDoc, status] = await Promise.all([
      AuctionModel.findById(this.auctionId).lean(),
      this.service.getAuctionStatus(this.auctionId, 1),
    ]);

    if (!auctionDoc || !status) return;
    if (status.status !== 'active' || !status.currentRoundNo || !status.roundEndsAt) return;

    const currency = String(auctionDoc.currency ?? status.currency ?? 'RUB') || 'RUB';
    await this.ensureParticipants(currency);

    // Проверка excludeUser - боты не перебивают этого пользователя
    const excludeUser = (auctionDoc.autoParticipants as any)?.excludeUser;
    if (excludeUser) {
      const currentLeader = status.leaders?.[0]?.participantId;
      if (currentLeader && String(currentLeader) === String(excludeUser)) {
        return;
      }
    }

    // Получаем все ставки в текущем раунде для проверки логики
    const allBids = await BidModel.find({
      auctionId: this.auctionId,
      roundNo: status.currentRoundNo,
      status: 'placed'
    })
      .sort({ createdAt: 1 })
      .lean();

    // ЖЕСТКАЯ ПРОВЕРКА: Проверяем, был ли уже хотя бы ОДИН переход от ЛЮБОГО пользователя к ЛЮБОМУ боту
    let humanToBotOccurred = false;
    for (let i = 1; i < allBids.length; i++) {
      const prev = allBids[i - 1];
      const curr = allBids[i];
      
      const prevIsUser = !this.isBot(prev.participantId);
      const currIsBot = this.isBot(curr.participantId);
      
      if (prevIsUser && currIsBot) {
        // Нашли переход: пользователь → бот
        humanToBotOccurred = true;
        break;
      }
    }

    // Если последняя ставка от пользователя И уже был переход пользователь → бот,
    // то НИКАКОЙ бот больше не может делать ставки
    if (allBids.length > 0) {
      const lastBid = allBids[allBids.length - 1];
      const lastIsUser = !this.isBot(lastBid.participantId);
      
      if (lastIsUser && humanToBotOccurred) {
        // Уже был переход пользователь → бот, и последняя ставка опять от пользователя
        // Боты больше не могут перебивать - пользователей можно перебить только ОДИН раз за раунд
        return;
      }
    }

    const endsAtMs = Date.parse(String(status.roundEndsAt));
    const msLeft = Number.isFinite(endsAtMs) ? endsAtMs - Date.now() : NaN;

    const minInc = Number(decToString(auctionDoc.minIncrement ?? '10'));
    const minIncSafe = Number.isFinite(minInc) && minInc > 0 ? minInc : 10;
    const top = Number(status.leaders?.[0]?.amount ?? 0);
    const topSafe = Number.isFinite(top) && top > 0 ? top : 0;

    const snipingWinSec = Number(auctionDoc.snipingWindowSec ?? 0);
    const aggressiveLastMs = Math.max(0, Math.min(15_000, (Number.isFinite(snipingWinSec) ? snipingWinSec : 0) * 1000));
    const inLastWindow = Number.isFinite(msLeft) && msLeft > 0 && msLeft <= (this.cfg.strategy === 'aggressive' ? Math.max(2_500, aggressiveLastMs) : 0);

    // вероятность ставки
    const pBid = this.cfg.strategy === 'aggressive' ? (inLastWindow ? 0.95 : 0.65) : 0.25;
    if (Math.random() > pBid) return;

    const multRange = this.cfg.strategy === 'aggressive'
      ? (inLastWindow ? [2, 10] : [1, 5])
      : [1, 3];
    const step = randInt(multRange[0]!, multRange[1]!) * minIncSafe;
    const next = topSafe > 0 ? topSafe + step : minIncSafe;

    const idem = `auto:${this.auctionId}:${pid}:r${status.currentRoundNo}:${Date.now()}`;
    const res = await this.service.placeBid(this.auctionId, {
      participantId: pid,
      amount: String(Math.round(next)),
      idempotencyKey: idem,
    });

    if ('error' in res && res.statusCode === 402) {
      const txId = `auto:${this.auctionId}:${pid}:topup:${Date.now()}`;
      try {
        await this.ledger.deposit(pid, this.defaults.defaultDepositAmount, currency, txId);
      } catch {
        return;
      }
      await this.service.placeBid(this.auctionId, {
        participantId: pid,
        amount: String(Math.round(next)),
        idempotencyKey: `${idem}:retry`,
      });
    }
  }

  private async tick() {
    if (!this.cfg.enabled) return;
    if (this.inflight >= (this.cfg.strategy === 'aggressive' ? 8 : 3)) return;

    const burst = this.cfg.strategy === 'aggressive' ? 2 : 1;
    for (let i = 0; i < burst; i++) {
      this.inflight++;
      Promise.resolve()
        .then(() => this.bidOnce())
        .catch(() => {})
        .finally(() => {
          this.inflight = Math.max(0, this.inflight - 1);
        });
    }
  }
}

export class AutoParticipantsManager {
  private readonly service = new AuctionService();
  private readonly ledger = new LedgerService();
  private readonly cfg = loadManagerCfg();

  private timer: NodeJS.Timeout | null = null;
  private readonly runners = new Map<string, AuctionAutoParticipantsRunner>();

  start() {
    if (!this.cfg.defaultEnabled) {
      // если глобальный автозапуск выключен — менеджер всё равно нужен для аукционов,
      // где enabled=true выставлен явно через UI/Dev.
    }

    this.stop();
    this.timer = setInterval(() => {
      void this.scan();
    }, this.cfg.scanMs);
    void this.scan();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const r of this.runners.values()) r.stop();
    this.runners.clear();
  }

  private shouldConsiderAuction(doc: any): boolean {
    if (!doc) return false;
    const ap = doc.autoParticipants as any;
    if (typeof ap?.enabled === 'boolean') return ap.enabled;
    return this.cfg.defaultEnabled;
  }

  private async scan() {
    const filter = this.cfg.defaultEnabled
      ? { status: { $in: ['draft', 'active'] } }
      : { status: { $in: ['draft', 'active'] }, 'autoParticipants.enabled': true };

    const auctions = await AuctionModel.find(filter, { _id: 1, status: 1, autoParticipants: 1 }).lean();

    const alive = new Set<string>();
    for (const a of auctions) {
      const id = String(a._id);
      if (!this.shouldConsiderAuction(a)) continue;
      alive.add(id);

      const eff = effectiveCfgFromAuction(a, this.cfg);
      if (!eff.enabled) continue;

      const existing = this.runners.get(id);
      if (existing) existing.updateCfg(eff);
      else {
        const r = new AuctionAutoParticipantsRunner(id, eff, { defaultDepositAmount: this.cfg.defaultDepositAmount }, this.service, this.ledger);
        this.runners.set(id, r);
        r.start();
      }
    }

    // стопаем то, что больше не нужно
    for (const [id, r] of [...this.runners.entries()]) {
      if (!alive.has(id)) {
        r.stop();
        this.runners.delete(id);
      }
    }
  }
}

