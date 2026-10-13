import { MAX_NOTICES, STATE_TTL_MS, WINDOW_MS, type Notice, type State } from "./engine";

export const COLLECTION_KEY = "Monitor:collection:health";
export const COLLECTION_CONFIRM_MS = 30 * 60_000;
export const COLLECTION_REMINDER_MS = 12 * 60 * 60_000;

export interface CollectionHealthState {
  since: number;
  lastFailureWindow: number;
  lastSuccessWindow: number;
  failures: number;
  good: number;
  lastCompleteAt: number;
  lastNotifiedAt: number;
  notified: boolean;
  reason: string;
  // Internal recipient receipts for this incident; never expose from /health.
  acceptedRecipients?: string[];
}

function time(value: number): string {
  return new Date(value + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

// Only caller-owned, sanitized collection classifications belong here. Raw
// provider responses, SQL, credentials and request URLs must never be passed in.
export function observeCollection(state: State, errors: string[], now: number, observedWindow: number): void {
  if (!state.collection) {
    state.collection = {
      since: 0, lastFailureWindow: 0, lastSuccessWindow: 0, failures: 0,
      good: 0, lastCompleteAt: state.lastSuccess, lastNotifiedAt: 0,
      notified: false, reason: "",
    };
    // Upgrade the old stateless critical/open notices without sending them.
    state.outbox = state.outbox.filter(notice => notice.key !== COLLECTION_KEY);
  }
  const health = state.collection;
  if (!errors.length) {
    if (observedWindow <= health.lastSuccessWindow) return;
    health.lastSuccessWindow = observedWindow;
    health.lastCompleteAt = now;
    health.good++;
    // A pending failure is stale as soon as a complete observation arrives.
    // Confirm recovery over two distinct windows, without a recovery email.
    const waiting = state.outbox.find(notice => notice.key === COLLECTION_KEY);
    if (waiting) health.acceptedRecipients = [...new Set([...(health.acceptedRecipients ?? []), ...waiting.delivered])];
    state.outbox = state.outbox.filter(notice => notice.key !== COLLECTION_KEY);
    if (health.good >= 2) {
      health.since = 0;
      health.failures = 0;
      health.notified = false;
      health.lastNotifiedAt = 0;
      health.reason = "";
      health.acceptedRecipients = [];
    }
    return;
  }

  const failureWindow = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  if (!health.since) health.since = now;
  if (failureWindow !== health.lastFailureWindow) {
    health.failures++;
    health.lastFailureWindow = failureWindow;
  }
  health.good = 0;
  health.reason = [...new Set(errors)].slice(0, 6).join("；").slice(0, 500);
  if (now - health.since < COLLECTION_CONFIRM_MS || health.failures < 3) return;

  const minutes = Math.max(1, Math.floor((now - health.since) / 60_000));
  const evidence = {
    resource: "Cloudflare 用量采集",
    metric: "监控数据缺口",
    value: `已持续 ${minutes} 分钟，${health.failures} 次采集未完整`,
    window: `${time(health.since)} 起（UTC+8）`,
    threshold: "持续至少 30 分钟且至少 3 个采集周期不完整",
    impact: "部分费用或用量数据暂不可用；这不是已确认的费用超支。",
    action: `检查受影响的数据源：${health.reason}。核对权限、指标支持及上报延迟。`,
    cost: health.lastCompleteAt ? `最近完整采集：${time(health.lastCompleteAt)}（UTC+8）` : "尚无完整采集记录。",
  };
  const text = `监控数据缺口：Cloudflare 用量采集\n${evidence.value}\n${evidence.impact}\n${evidence.window}\n${evidence.cost}\n建议：${evidence.action}`;
  const waiting = state.outbox.find(notice => notice.key === COLLECTION_KEY);
  if (waiting) {
    waiting.text = text;
    waiting.evidence = evidence;
    waiting.severity = 1;
    // Keep partial-recipient receipts: updated evidence is the same incident.
    return;
  }
  if (health.notified && now - health.lastNotifiedAt < COLLECTION_REMINDER_MS) return;
  if (state.outbox.length >= MAX_NOTICES) return; // Retry next tick; never overflow state.
  const kind = health.notified ? "reminder" : "open";
  state.outbox.push({
    id: `${COLLECTION_KEY}:${health.since}:${kind}:${Math.floor(now / COLLECTION_REMINDER_MS)}`,
    key: COLLECTION_KEY, kind, severity: 1, text, evidence,
    delivered: [...(health.acceptedRecipients ?? [])], attempts: 0, expiresAt: now + STATE_TTL_MS,
  });
}

export function acknowledgeCollection(state: State, notice: Notice, now: number): void {
  const health = state.collection;
  if (!health || notice.key !== COLLECTION_KEY || !notice.id.startsWith(`${COLLECTION_KEY}:${health.since}:`)) return;
  health.notified = true;
  health.lastNotifiedAt = now;
  health.acceptedRecipients = [];
}

export function billingDue(state: State, now: number): boolean {
  if (state.lastBilling && now - state.lastBilling < 6 * 3600_000) return false;
  // A failed billing read must not turn a six-hour reconciliation into twelve
  // requests per hour. Retry independently of the healthy fast telemetry.
  return !state.lastBillingAttempt || now - state.lastBillingAttempt >= 3600_000;
}
