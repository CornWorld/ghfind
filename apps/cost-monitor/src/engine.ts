// Bounded, aggregated telemetry only: no user IDs, SQL text, parameters or bodies.
export const WINDOW_MS = 5 * 60_000;
export const HISTORY_TTL_MS = 24 * 60 * 60_000;
export const STATE_TTL_MS = 7 * HISTORY_TTL_MS;
export const MAX_POINTS = 192;
export const MAX_METRICS = 256;
export const MAX_WINDOWS = 288;
export const MAX_STATE_BYTES = 192 * 1024;
export const MAX_NOTICES = 64;
export const MAX_WINDOW_BYTES = 48 * 1024;
export const REMINDER_MS = 30 * 60_000;
export type Product = "D1" | "Workers" | "R2" | "KV" | "DO" | "Queues" | "Billing" | "Monitor" | "Service";
export interface Point {
  key: string;
  product: Product;
  resource: string;
  label: string;
  amount: number;
  operations: number;
  unit: string;
  // Conservative consumption at published overage rates, BEFORE included quota.
  usd: number;
  efficiency?: number;
  efficiencyWarning?: number;
  efficiencyCritical?: number;
  minAmount?: number;
  minOperations?: number;
  observedAt?: number;
  gauge?: boolean;
  denominator?: string;
  relative?: boolean;
  diagnostic?: boolean; // Per-SQL breakdown: never double count database cost.
}
export interface Frame {
  at: number;
  points: Point[];
  healthy: Product[];
  errors: string[];
  completeQueries?: boolean;
  // Optional SQL diagnostics do not determine whether consumption was collected.
  diagnostics?: string[];
  costComplete?: boolean;
}
export interface MetricState {
  baseline: number;
  samples: number;
  bad: number;
  good: number;
  severity: number;
  notifiedSeverity: number;
  lastNotified: number;
  lastSeen: number;
  expiresAt: number;
  incident: number;
  gauge?: boolean;
  diagnostic?: boolean;
  // Account-only closed 5-minute cost buckets. Never fill missing windows with zero.
  burnWindows?: [at: number, usd: number][];
  // Keep the last evidence that actually confirmed the incident's latched level.
  trigger?: { at: number; severity: number; basis: "absolute" | "relative" | "burn" | "billing"; condition: string; observed: string };
}
export interface NoticeEvidence { resource: string; metric: string; value: string; threshold?: string; window: string; action: string; impact?: string; cost?: string }
export interface Notice { id: string; key: string; kind: "open" | "reminder" | "escalation" | "recovery"; severity: number; text: string; evidence?: NoticeEvidence; delivered: string[]; attempts: number; expiresAt: number }
export interface State {
  lastFrame: number;
  lastSuccess: number;
  lastAttempt: number;
  lastBilling: number;
  metrics: Record<string, MetricState>;
  outbox: Notice[];
  recentDelivery: { at: number; id: string; kind: string; recipients: number }[];
  mailReceipts: { at: number; messageId: string }[];
  mailBudget: { hour: number; hourly: number; day: number; daily: number };
  lastError: string | null;
  nextDigest?: number;
  digestRecipients?: string[];
  collection?: import("./collection-health").CollectionHealthState;
  lastDeliveryError?: string | null;
  lastBillingAttempt?: number;
  lastBillingError?: string | null;
  lastCompletedAt?: number;
}
export function emptyState(): State {
  return { lastFrame: 0, lastSuccess: 0, lastAttempt: 0, lastBilling: 0, metrics: {}, outbox: [], recentDelivery: [], mailReceipts: [], mailBudget: {hour:0,hourly:0,day:0,daily:0}, lastError: null };
}
export interface Rules { hourlyWarning: number; hourlyCritical: number; dailyWarning: number }
export const DEFAULT_RULES: Rules = { hourlyWarning: 0.5, hourlyCritical: 2, dailyWarning: 10 };
export function recipients(value: string): string[] {
  const input: unknown = JSON.parse(value);
  if (!Array.isArray(input)) throw new Error("ALERT_RECIPIENTS must be a JSON list");
  // Empty placeholders are permitted; addresses are kept in secrets, not git.
  const addresses = [...new Set(input.filter((x): x is string => typeof x === "string").map(x => x.trim().toLowerCase()).filter(Boolean))];
  if (input.some(x => typeof x !== "string") || !addresses.length || addresses.length > 20 || addresses.some(x => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x))) throw new Error("Invalid alert recipient list");
  return addresses;
}
export function compact(state: State, now: number): void {
  for (const [key, value] of Object.entries(state.metrics)) if (value.expiresAt <= now) delete state.metrics[key];
  state.outbox = state.outbox.filter(n => n.expiresAt > now).slice(-MAX_NOTICES);
  state.mailReceipts = state.mailReceipts.filter(n => n.at > now - HISTORY_TTL_MS).slice(-12);
  state.recentDelivery = state.recentDelivery.filter(n => n.at > now - HISTORY_TTL_MS).slice(-12);
}
export function validateFrame(frame: Frame): void {
  if (!Number.isFinite(frame.at) || frame.points.length > MAX_POINTS || JSON.stringify(frame).length > MAX_WINDOW_BYTES) throw new Error("Telemetry window exceeds bounds");
  const keys = new Set<string>();
  for (const p of frame.points) {
    if (keys.has(p.key) || p.key.length > 160 || p.resource.length > 100 || p.label.length > 120 || [p.amount, p.operations, p.usd, p.efficiency ?? 0].some(n => !Number.isFinite(n) || n < 0)) throw new Error("Invalid or duplicate metric");
    keys.add(p.key);
  }
}
export function evaluate(state: State, frame: Frame, now: number, rules = DEFAULT_RULES): void {
  validateFrame(frame);
  compact(state, now);
  if (frame.at < state.lastFrame) return; // Never process older windows.
  if (frame.at - state.lastFrame > WINDOW_MS && state.lastFrame) {
    for (const metric of Object.values(state.metrics)) { metric.bad = 0; metric.good = 0; }
  }
  const points = [...frame.points];
  const priced = frame.points.filter(p => !p.diagnostic && p.product !== "Billing");
  if (["D1", "Workers", "R2", "KV", "DO", "Queues"].every(p => frame.healthy.includes(p as Product))) points.push({ key: "account:burn", product: "Monitor", resource: "account", label: "已覆盖产品的用量消耗速度（不含外部 LLM 等费用）", amount: priced.reduce((s,p) => s+p.usd,0)*12, operations: 1, unit: "USD/hour", usd: priced.reduce((s,p) => s+p.usd,0) });
  // Keys measured in this window; the zero points added below for vanished
  // metrics are bookkeeping and must not pin those metrics against eviction.
  const measured = new Set(points.map(p => p.key));
  // Only a successful product collection can establish that a vanished metric is zero.
  for (const [key, previous] of Object.entries(state.metrics)) {
    const parts = key.split(":");
    const product = parts[0] as Product;
    if (!previous.gauge && (!previous.diagnostic || frame.completeQueries) && frame.healthy.includes(product) && !points.some(p => p.key === key)) {
      points.push({ key, product, resource: parts[1] ?? "resource", label: "已停止的异常用量", amount: 0, operations: 0, unit: "units", usd: 0 });
    }
    if (previous.expiresAt <= now) delete state.metrics[key];
  }
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let m = state.metrics[p.key];
    if (!m) {
      if (Object.keys(state.metrics).length >= MAX_METRICS) {
        const evict = Object.entries(state.metrics).filter(([key,v])=>!v.severity && !v.notifiedSeverity && !v.bad && !measured.has(key)).sort((a,b)=>a[1].lastSeen-b[1].lastSeen)[0];
        if(!evict) throw new Error("Metric cardinality limit exceeded");
        delete state.metrics[evict[0]];
        // Drop its pending zero point too, or it would be re-created below.
        const pending = points.findIndex((q,j)=>j>i && q.key===evict[0]);
        if (pending >= 0) points.splice(pending, 1);
      }
      m = state.metrics[p.key] = { baseline: 0, samples: 0, bad: 0, good: 0, severity: 0, notifiedSeverity: 0, lastNotified: 0, lastSeen: 0, expiresAt: now + STATE_TTL_MS, incident: 0, gauge: p.gauge, diagnostic: p.diagnostic };
    }
    if (m.lastSeen === frame.at) continue; // Source correction can fill missing metrics, never train an existing one twice.
    if (m.lastSeen && frame.at-m.lastSeen>WINDOW_MS && p.product!=="Billing") {m.bad=0;m.good=0;}
    const value = p.efficiency ?? p.amount;
    const enough = (p.gauge || p.operations >= (p.minOperations ?? 20)) && p.amount >= (p.minAmount ?? 100);
    let level = 0;
    if (enough && p.efficiencyWarning !== undefined && value >= p.efficiencyWarning) level = 1;
    if (enough && p.efficiencyCritical !== undefined && value >= p.efficiencyCritical) level = 2;
    const ratio = m.baseline > 0 ? value / m.baseline : 0;
    if (enough && (p.diagnostic || p.usd * 12 >= 0.05) && m.samples >= 12 && p.relative !== false && ratio >= 3) level = Math.max(level, 1);
    if (enough && (p.diagnostic || p.usd * 12 >= 0.5) && m.samples >= 12 && p.relative !== false && ratio >= 10) level = 2;
    if (p.key === "account:burn") level = value >= rules.hourlyCritical ? 2 : value >= rules.hourlyWarning ? 1 : 0;
    if (p.product === "Billing") level = value >= rules.dailyWarning * 3 ? 2 : value >= rules.dailyWarning ? 1 : 0;
    if (level) {
      m.bad++; m.good = 0;
      if (level === 2 || m.bad >= 2 || p.product === "Billing") {
        if (!m.severity) m.incident = frame.at;
        m.severity = Math.max(m.severity, level);
      }
    } else {
      m.bad = 0; m.good++;
      if (m.good >= 2) m.severity = 0;
      // Freeze the baseline while suspicious/active, so an incident never becomes "normal".
      if (!m.severity && m.good >= 2 && (p.operations >= 20 || p.gauge)) {
        m.baseline = m.samples ? m.baseline * 0.98 + value * 0.02 : value;
        m.samples++;
      }
    }
    m.lastSeen = frame.at; m.expiresAt = now + STATE_TTL_MS;
    // An ordinary incident that recovered before its digest must not send a stale fault.
    if (!m.severity && !m.notifiedSeverity) {
      state.outbox=state.outbox.filter(n=>n.key!==p.key || n.delivered.length>0);
    }
    const waiting=state.outbox.find(n=>n.key===p.key);
    if(waiting && m.severity>waiting.severity){
      waiting.severity=m.severity;waiting.kind="escalation";
      waiting.text=describeNotice(p,m,frame.at,ratio);waiting.delivered=[];
    }
    let kind: Notice["kind"] | undefined;
    if (!m.severity && m.notifiedSeverity && p.product === "Service") {
      // Healthy business windows are bookkeeping, not another fault email.
      m.notifiedSeverity = 0;
      m.lastNotified = now;
      state.outbox = state.outbox.filter(n => n.key !== p.key);
    }
    if (!m.severity && m.notifiedSeverity) kind = "recovery";
    else if (m.severity && !m.notifiedSeverity) kind = "open";
    else if (m.severity > m.notifiedSeverity) kind = "escalation";
    else if (m.severity && now - m.lastNotified >= REMINDER_MS) kind = "reminder";
    if (kind && !state.outbox.some(n => n.key === p.key)) {
      if (state.outbox.length >= MAX_NOTICES) throw new Error("Notification outbox limit exceeded");
      state.outbox.push({ id: `${p.key}:${m.incident}:${kind}:${Math.floor(now/REMINDER_MS)}`, key: p.key, kind, severity: m.severity,
        text: describeNotice(p, m, frame.at, ratio),
        delivered: [], attempts: 0, expiresAt: now + STATE_TTL_MS });
    }
  }
  state.lastFrame = frame.at;
  if (["D1", "Workers", "R2", "KV", "DO", "Queues"].every(p => frame.healthy.includes(p as Product)) && !frame.errors.length) state.lastSuccess = now;
  state.lastError = frame.errors.length ? frame.errors.join("; ").slice(0,500) : null;
}
export function acknowledge(state: State, notice: Notice, now: number): void {
  const m = state.metrics[notice.key];
  if (m) { m.notifiedSeverity = notice.severity; m.lastNotified = now; }
  state.outbox = state.outbox.filter(n => n.id !== notice.id);
  state.recentDelivery.push({ at: now, id: notice.id, kind: notice.kind, recipients: notice.delivered.length });
  compact(state, now);
}

const RESOURCE_NAMES: Record<string,string> = {
  "e4695b85cce24b3d843c4744865ed203": "共享协调缓存（ghfind-coord / KeyValue）",
  "60d45096-bfe7-4de1-8b85-c1b66a466b0d": "主数据库 ghfind",
  "9c4ac13a-4c90-40a8-9d56-d7141f864bbf": "Feed 数据库",
  "f7a7299eef224d899c21121c1979be32": "应用缓存 ghfind-cache",
  account: "Cloudflare 账户",
};
function money(n:number):string { return n>0 && n<0.000001 ? "<$0.000001" : `$${n.toFixed(6)}`; }
export function describeNotice(p:Point,m:MetricState,at:number,ratio:number):string {
  const category = p.product==="Service" ? "关键功能故障" : p.key.endsWith(":errors") ? "运行错误" : p.product==="Billing" || p.key==="account:burn" ? "账单风险" : "性能 / 用量异常";
  const time = (n:number)=>new Date(n+8*3600_000).toISOString().slice(0,16).replace("T"," ");
  const advice = p.product==="Service" ? "优先检查该功能的部署、上游服务和生成结果日志；故障可能直接影响用户。" : p.product==="D1" ? "检查查询计划、索引、缓存命中与重复查询。" : p.product==="DO" || p.product==="KV" ? "检查缓存命中、协调对象轮询、重试与批量读写。" : p.product==="Workers" ? "检查异常日志、CPU 耗时、循环与近期部署。" : "检查流量变化、重复操作及近期部署。";
  const evidence = p.efficiency===undefined ? "" : `\n平均每次${p.denominator??"操作"}：${p.efficiency.toFixed(4)} ${p.unit}${p.denominator==="账户 Worker 调用（归一化参考）"?"；不是该资源实际查询次数":""}`;
  const baseline = p.relative===false ? "" : `\n健康参考：${m.baseline.toFixed(4)}；相对倍数：${ratio.toFixed(2)}（倍数不能单独代表费用风险）`;
  const cost = p.product==="Billing" ? `已上报日费用：$${p.amount.toFixed(4)}；对应日期：${p.resource}。账单可能延迟或调整，每 6 小时重新对账。` : p.product==="Service" || p.key.endsWith(":errors") ? "这是功能 / 错误告警，不按费用大小降级。" : `本窗口套餐外单价估算：${money(p.usd)}；若持续同速约 ${money(p.usd*12)}/小时、${money(p.usd*288)}/天。未扣套餐额度，非最终账单。`;
  const period=p.observedAt ? `探测时间（北京时间）：${time(p.observedAt)}` : `北京时间：${time(at)} 至 ${time(at+WINDOW_MS)}；UTC 开始：${new Date(at).toISOString()}`;
  return `【${category}】${RESOURCE_NAMES[p.resource]??p.resource} / ${p.label}\n影响对象：${RESOURCE_NAMES[p.resource]??p.resource}（${p.product}）\n${m.severity?"需要排查":"已连续两个有效窗口恢复正常"}\n观测值：${p.amount.toLocaleString("en-US")} ${p.unit}；${p.denominator??"操作"}数：${p.operations}${evidence}${baseline}\n${period}\n${cost}\n建议：${advice}`;
}
