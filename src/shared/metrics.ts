import {
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

export const registry = new Registry();

export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const bidsTotal = new Counter({
  name: 'bids_total',
  help: 'Total number of bid placement attempts',
  labelNames: ['result', 'reason'] as const,
  registers: [registry],
});

export const auctionsActive = new Gauge({
  name: 'auctions_active',
  help: 'Number of active auctions',
  registers: [registry],
});

export const ledgerOpsTotal = new Counter({
  name: 'ledger_ops_total',
  help: 'Total ledger operations',
  labelNames: ['kind', 'result', 'reason'] as const,
  registers: [registry],
});

export const versionConflictsTotal = new Counter({
  name: 'version_conflicts_total',
  help: 'Total number of optimistic locking version conflicts',
  labelNames: ['operation', 'model'] as const,
  registers: [registry],
});

export const retriesTotal = new Counter({
  name: 'retries_total',
  help: 'Total number of transaction retries',
  labelNames: ['operation', 'reason'] as const,
  registers: [registry],
});

export const reconcileIssuesTotal = new Counter({
  name: 'reconcile_issues_total',
  help: 'Total number of reconcile issues detected',
  labelNames: ['type', 'status'] as const,
  registers: [registry],
});

