import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.3/index.js';

const MODE = (__ENV.MODE || 'default').trim();

const API_BASE_URL = (__ENV.API_BASE_URL || 'http://localhost:3000/api').replace(/\/$/, '');
const CURRENCY = __ENV.CURRENCY || 'RUB';

const AUCTION_ID = __ENV.AUCTION_ID;
const PARTICIPANTS = Number(__ENV.PARTICIPANTS || 100);

const LOTS_COUNT = Number(__ENV.LOTS_COUNT || 1);

const DURATION_SEC = Number(__ENV.DURATION_SEC || 60);
const STEADY_VUS = Number(__ENV.STEADY_VUS || 20);
const SPIKE_VUS = Number(__ENV.SPIKE_VUS || 50);
const SPIKE_LAST_SEC = Number(__ENV.SPIKE_LAST_SEC || 10);

const MIN_INCREMENT = __ENV.MIN_INCREMENT || '10';
const DEPOSIT_AMOUNT = __ENV.DEPOSIT_AMOUNT || '100000';

const SLEEP_NORMAL_SEC = Number(__ENV.SLEEP_NORMAL_SEC || 0.4);
const SLEEP_SPIKE_SEC = Number(__ENV.SLEEP_SPIKE_SEC || 0.05);

const ANTI_SNIPING_WINDOW_SEC = Number(__ENV.ANTI_SNIPING_WINDOW_SEC || 10);
const ANTI_SNIPING_EXTEND_SEC = Number(__ENV.ANTI_SNIPING_EXTEND_SEC || 10);
const ANTI_SNIPING_MAX_EXTENDS = Number(__ENV.ANTI_SNIPING_MAX_EXTENDS || 10);
const ANTI_ROUND_DURATION_SEC = Number(__ENV.ANTI_ROUND_DURATION_SEC || 20);

const auctionExtensionsObserved = new Counter('auction_extensions_observed');

function buildOptions() {
  const base = {
    scenarios: {
      steady: {
        executor: 'constant-vus',
        vus: STEADY_VUS,
        duration: `${Math.max(1, DURATION_SEC - SPIKE_LAST_SEC)}s`,
        exec: 'bidLoop',
      },
      spike: {
        executor: 'ramping-vus',
        startTime: `${Math.max(0, DURATION_SEC - SPIKE_LAST_SEC)}s`,
        stages: [{ duration: `${Math.max(1, SPIKE_LAST_SEC)}s`, target: SPIKE_VUS }],
        gracefulRampDown: '0s',
        exec: 'bidLoop',
      },
    },
    thresholds: {
      http_req_failed: ['rate<0.01'],
    },
  };

  if (MODE === 'anti_sniping') {
    return {
      ...base,
      thresholds: {
        ...base.thresholds,
        'auction_extensions_observed{mode:anti_sniping}': ['count>0'],
      },
    };
  }

  return base;
}

export const options = {
  ...buildOptions(),
};

const participants = new SharedArray('participants', () => {
  const count = Number.isFinite(PARTICIPANTS) && PARTICIPANTS > 0 ? Math.floor(PARTICIPANTS) : 1;
  return Array.from({ length: count }, (_, i) => `u${i + 1}`);
});

function api(path) {
  return `${API_BASE_URL}${path}`;
}

function ensure2xx(res, name) {
  const ok = check(res, {
    [`${name}: HTTP 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });
  if (!ok) fail(`${name} failed: ${res.status} ${String(res.body).slice(0, 400)}`);
}

function asJson(res, name) {
  try {
    return res.json();
  } catch {
    fail(`${name}: invalid JSON: ${String(res.body).slice(0, 400)}`);
  }
}

function validateAccount(acc, name) {
  if (!acc) return;
  const total = Number(acc.total);
  const held = Number(acc.held);
  const available = Number(acc.available);

  const ok = check(acc, {
    [`${name}: total>=0`]: () => Number.isFinite(total) && total >= 0,
    [`${name}: held>=0`]: () => Number.isFinite(held) && held >= 0,
    [`${name}: available>=0`]: () => Number.isFinite(available) && available >= 0,
  });
  if (!ok) fail(`${name}: negative/invalid balance: ${JSON.stringify(acc)}`);
}

function getAuctionStatus(id) {
  const res = http.get(api(`/auctions/${id}?leaders=1`));
  ensure2xx(res, 'get auction');
  return asJson(res, 'get auction');
}

function createAuction() {
  const code = `LOAD-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  const roundDurationSec = (() => {
    if (__ENV.ROUND_DURATION_SEC) return Number(__ENV.ROUND_DURATION_SEC);
    if (MODE === 'anti_sniping') return ANTI_ROUND_DURATION_SEC;
    return Math.floor(DURATION_SEC);
  })();

  const roundDurationSecSafe = Number.isFinite(roundDurationSec) && roundDurationSec > 0 ? Math.floor(roundDurationSec) : 10;

  const antiOn = MODE === 'anti_sniping';

  const payload = JSON.stringify({
    code,
    title: 'Load test auction',
    lotsCount: Number.isFinite(LOTS_COUNT) && LOTS_COUNT > 0 ? Math.floor(LOTS_COUNT) : 1,
    currency: CURRENCY,
    // делаем короткий раунд под anti-sniping (или задаём ROUND_DURATION_SEC)
    roundDurationSec: Math.max(10, roundDurationSecSafe),
    minIncrement: MIN_INCREMENT,
    topK: Math.min(10, participants.length),
    // anti-sniping: включаем/выключаем через MODE
    snipingWindowSec: antiOn ? Math.max(0, Math.floor(ANTI_SNIPING_WINDOW_SEC)) : 0,
    extendBySec: antiOn ? Math.max(0, Math.floor(ANTI_SNIPING_EXTEND_SEC)) : 0,
    maxExtensionsPerRound: antiOn ? Math.max(0, Math.floor(ANTI_SNIPING_MAX_EXTENDS)) : 0,
  });

  const res = http.post(api('/auctions'), payload, { headers: { 'content-type': 'application/json' } });
  ensure2xx(res, 'create auction');
  const body = asJson(res, 'create auction');
  const id = body?.id || body?._id || body?.auctionId;
  if (!id) fail(`create auction: missing id in response: ${JSON.stringify(body)}`);
  return id;
}

function startAuction(id) {
  const res = http.post(api(`/auctions/${id}/start`), null);
  ensure2xx(res, 'start auction');
  return asJson(res, 'start auction');
}

function deposit(subjectId) {
  const payload = JSON.stringify({ amount: DEPOSIT_AMOUNT, currency: CURRENCY });
  const res = http.post(api(`/accounts/${encodeURIComponent(subjectId)}/deposit`), payload, {
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `k6-deposit:${subjectId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    },
  });
  ensure2xx(res, 'deposit');
  const body = asJson(res, 'deposit');
  validateAccount(body?.account, 'deposit account');
}

export function setup() {
  const maxVus = Math.max(STEADY_VUS, SPIKE_VUS);
  if (participants.length < maxVus) {
    fail(`PARTICIPANTS (${participants.length}) must be >= max(STEADY_VUS, SPIKE_VUS) (${maxVus}) to avoid participant collisions`);
  }

  let auctionId = AUCTION_ID;
  let roundEndsAt = null;

  if (!auctionId) {
    auctionId = createAuction();
    const started = startAuction(auctionId);
    roundEndsAt = started?.roundEndsAt || null;
  } else {
    const st = getAuctionStatus(auctionId);
    if (st?.status === 'draft') {
      const started = startAuction(auctionId);
      roundEndsAt = started?.roundEndsAt || st?.roundEndsAt || null;
    } else {
      roundEndsAt = st?.roundEndsAt || null;
      if (st?.status !== 'active') fail(`AUCTION_ID must be active/draft, got status=${st?.status}`);
    }
  }

  for (const p of participants) deposit(p);

  return {
    mode: MODE,
    auctionId,
    roundEndsAt,
    minIncrement: Number(MIN_INCREMENT),
  };
}

let myBid = 0;
let lastKnownEndsAtMs = 0;

export function bidLoop(data) {
  const auctionId = data.auctionId;
  const participantId = participants[(__VU - 1) % participants.length];
  const minInc = Number.isFinite(data.minIncrement) && data.minIncrement > 0 ? data.minIncrement : 10;

  if (!lastKnownEndsAtMs && data.roundEndsAt) {
    const ms = Date.parse(data.roundEndsAt);
    if (Number.isFinite(ms)) lastKnownEndsAtMs = ms;
  }

  if (!myBid) myBid = minInc * 10 + (__VU % 10) * minInc;
  myBid += minInc;

  const payload = JSON.stringify({
    participantId,
    amount: myBid.toString(),
    idempotencyKey: `k6:${participantId}:${__VU}:${__ITER}:${myBid}`,
  });

  const res = http.post(api(`/auctions/${auctionId}/bids`), payload, { headers: { 'content-type': 'application/json' } });

  if (res.status >= 200 && res.status < 300) {
    const body = asJson(res, 'place bid');
    const ok = check(body, {
      'place bid: accepted=true': (b) => b && b.accepted === true,
    });
    if (!ok) fail(`place bid not accepted: ${JSON.stringify(body)}`);

    validateAccount(body?.account, 'bid account');

    const newEndsAtMs = body?.roundEndsAt ? Date.parse(body.roundEndsAt) : NaN;
    if (Number.isFinite(newEndsAtMs)) {
      if (lastKnownEndsAtMs && newEndsAtMs > lastKnownEndsAtMs + 200) {
        auctionExtensionsObserved.add(1, { mode: data.mode || MODE });
      }
      lastKnownEndsAtMs = Math.max(lastKnownEndsAtMs || 0, newEndsAtMs);
    }
  } else if (res.status === 409) {
    // round can be closed concurrently by worker; just refresh endsAt
    const st = getAuctionStatus(auctionId);
    const ms = st?.roundEndsAt ? Date.parse(st.roundEndsAt) : NaN;
    if (Number.isFinite(ms)) lastKnownEndsAtMs = ms;
  } else {
    fail(`place bid failed: ${res.status} ${String(res.body).slice(0, 400)}`);
  }

  const now = Date.now();
  const inSpike = Number.isFinite(lastKnownEndsAtMs) && lastKnownEndsAtMs > 0 ? lastKnownEndsAtMs - now <= SPIKE_LAST_SEC * 1000 : false;
  sleep(inSpike ? SLEEP_SPIKE_SEC : SLEEP_NORMAL_SEC);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'load/summary.json': JSON.stringify(data, null, 2),
  };
}

