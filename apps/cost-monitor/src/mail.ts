import type { Notice } from "./engine";
import { urgent } from "./mail-policy";

export interface MailOptions {
  accountId: string;
  now: number;
  exercise?: boolean;
  digest?: boolean;
}
export interface RenderedMail { subject: string; text: string; html: string }
interface Item {
  notice: Notice;
  resource: string;
  metric: string;
  value: string;
  threshold: string;
  window: string;
  action: string;
  impact: string;
  cost: string;
}
interface Group { key: string; resource: string; items: Item[]; rank: number; recovered: boolean }
const TOP_GROUPS = 3;
const TOP_METRICS = 3;
const OTHER_GROUPS = 5;
const RUNBOOK = "https://github.com/hikariming/ghfind/tree/main/apps/cost-monitor#readme";
const TITLES = { open: "新增", escalation: "升级", reminder: "持续", recovery: "恢复" };

function escape(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function line(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
function short(value: string, length: number): string {
  const chars = Array.from(line(value));
  return chars.length > length ? chars.slice(0, length - 1).join("") + "…" : chars.join("");
}
function field(lines: string[], name: string): string {
  return lines.find(s => s.startsWith(name + "："))?.slice(name.length + 1).trim() ?? "";
}
// Translate only the collector's fixed, sanitized classifications. Keep source
// names and unknown legacy classifications intact for diagnosis.
function collectionWords(value: string): string {
  const categories: [string, string][] = [
    ["access denied; check analytics token permissions", "权限不足，请核对 Analytics Token 权限"],
    ["rate limited; retry next scheduled window", "请求限流，等待下一采集周期重试"],
    ["dataset unavailable or unsupported", "数据集不可用或当前套餐不支持"],
    ["result limit reached; coverage incomplete", "结果条数达到上限，数据覆盖不完整"],
    ["response size limit reached; coverage incomplete", "响应体达到上限，数据覆盖不完整"],
    ["collection could not be completed; inspect the bounded collector logs", "采集未完成，请检查采集器日志"],
    ["Collection failed, delayed or exceeded bounded telemetry limits", "采集失败、上报延迟或达到采集上限"],
    ["reconciliation unavailable", "账单对账暂不可用"],
    ["request timed out", "采集请求超时"],
    ["collection unavailable", "采集暂不可用"],
    ["rate limited", "请求限流"],
  ];
  return categories.reduce((result, [source, translation]) => result.split(source).join(translation), value);
}
function collection(notice: Notice): boolean { return notice.key === "Monitor:collection:health"; }
function billing(notice: Notice): boolean { return notice.key === "account:burn" || notice.key.startsWith("Billing:"); }
function parse(notice: Notice): Item {
  const lines = notice.text.split("\n").map(line).filter(Boolean);
  if (collection(notice)) return {
    notice, resource: "Cloudflare 用量采集", metric: "监控数据缺口",
    value: collectionWords(notice.evidence?.value || field(lines, "状态") || "尚未获得完整的有效数据"),
    threshold: notice.evidence?.threshold || "", window: notice.evidence?.window || field(lines, "时间") || field(lines, "北京时间"),
    action: collectionWords(notice.evidence?.action || "检查监控采集状态、API Token 权限和 Cloudflare 数据上报延迟。"),
    impact: "部分用量暂时无法判断；数据缺口本身不代表费用超支或业务故障。", cost: notice.evidence?.cost || "",
  };
  if (notice.evidence) return { notice, ...notice.evidence, threshold: notice.evidence.threshold ?? "", impact: notice.evidence.impact ?? "", cost: notice.evidence.cost ?? "" };
  const first = (lines[0] ?? notice.key).replace(/^【[^】]*】\s*/, "");
  const slash = first.indexOf(" / ");
  const product = notice.key.split(":")[0];
  const resource = field(lines, "影响对象").replace(/（[^（）]*）$/, "") || (slash >= 0 ? first.slice(0, slash) : first);
  const metric = slash >= 0 ? first.slice(slash + 3) : first;
  const window = lines.find(s => /^(北京时间|探测时间（北京时间）|观测时间|时间窗口|统计窗口|窗口|时间)：/.test(s)) ?? "";
  const cost = lines.find(s => /^(本窗口套餐外单价估算|已上报日费用|估算费用|费用说明|已覆盖用量)/.test(s)) ?? "";
  const action = field(lines, "建议") || (product === "Service" ? "检查该功能的近期部署和上游服务。" : "对照监控数据检查近期流量、部署和重试变化。");
  return {
    notice, resource, metric,
    value: field(lines, "观测值") || field(lines, "当前值") || "详见指标证据",
    threshold: field(lines, "触发条件") || field(lines, "触发阈值") || field(lines, "阈值") || field(lines, "触发依据"),
    window, action, cost,
    impact: product === "Service" ? "该功能出现失败或慢响应，可能影响用户使用。" : billing(notice) ? "用量或已上报费用达到告警条件，需核对消耗来源。" : "该资源的用量或运行效率偏离告警条件，需核对实际影响。",
  };
}
function groupsFor(notices: Notice[]): Group[] {
  const groups = new Map<string, Group>();
  for (const notice of notices) {
    const item = parse(notice);
    // A database's SQL fingerprints and aggregate counters share one resource.
    // A recovered metric never changes an active group's status to healthy.
    const key = `${notice.key.split(":").slice(0, 2).join(":")}:${notice.kind === "recovery" ? "resolved" : "active"}`;
    const rank = notice.kind === "recovery" ? 0 : collection(notice) ? 1 : urgent(notice) ? (notice.key.startsWith("Service:") ? 6 : 5) : notice.key.startsWith("Service:") ? 4 : billing(notice) ? 3 : 2;
    const group = groups.get(key) ?? { key, resource: item.resource, items: [], rank, recovered: notice.kind === "recovery" };
    group.items.push(item);
    group.rank = Math.max(group.rank, rank);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.rank - a.rank || a.key.localeCompare(b.key)).map(group => ({
    ...group,
    items: group.items.sort((a, b) => b.notice.severity - a.notice.severity || a.notice.key.localeCompare(b.notice.key)),
  }));
}
function groupStatus(group: Group): string {
  if (group.recovered) return "已恢复";
  if (group.items.every(i => collection(i.notice))) return "数据缺口";
  if (group.items.some(i => urgent(i.notice))) return "需要处理";
  return group.items.every(i => i.notice.kind === "reminder") ? "仍在持续" : "需要排查";
}
function summary(groups: Group[]): string {
  const active = groups.filter(g => !g.recovered);
  if (!active.length) return groups.length ? `${groups.length} 个受影响对象已恢复` : "本次没有待通知的异常";
  const lead = active[0];
  if (active.every(g => g.items.every(i => collection(i.notice)))) return "用量数据暂不完整，请检查采集";
  const kind = lead.items.some(i => i.notice.key.startsWith("Service:") && i.notice.key.endsWith(":errors")) ? "功能故障" : lead.items.some(i => billing(i.notice)) ? "费用告警" : "指标异常";
  return `${short(lead.resource, 26)}${kind}${active.length > 1 ? `，另有 ${active.length - 1} 个对象待排查` : ""}`;
}
function time(at: number): string {
  return new Date(at + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ") + " UTC+8";
}
function countLine(notices: Notice[], groups: Group[]): string {
  const counts = notices.reduce((c, n) => { c[n.kind]++; return c; }, { open: 0, escalation: 0, reminder: 0, recovery: 0 });
  const parts = (Object.keys(TITLES) as Notice["kind"][]).filter(k => counts[k]).map(k => `${TITLES[k]} ${counts[k]}`);
  return `${groups.length} 个对象 · ${notices.length} 项指标${parts.length ? " · " + parts.join(" / ") : ""}`;
}
function textEvidence(item: Item): string {
  if (collection(item.notice)) return `${TITLES[item.notice.kind]} · 监控数据缺口\n影响：${item.impact}\n状态：${item.value}${item.threshold ? `\n条件：${item.threshold}` : ""}${item.window ? `\n时间：${item.window}` : ""}\n下一步：${item.action}${item.cost ? `\n${item.cost}` : ""}`;
  const evidence = item.notice.evidence ? [`观测：${item.value}`, item.threshold ? `条件：${item.threshold}` : "", item.window, `下一步：${item.action}`, item.impact ? `影响：${item.impact}` : "", item.cost].filter(Boolean).join("\n") : "";
  return [`${TITLES[item.notice.kind]} · ${item.metric}`, evidence || item.notice.text].filter(Boolean).join("\n");
}
function metricHtml(item: Item): string {
  const facts = [`观测：${short(item.value, 150)}`, item.threshold ? `条件：${short(item.threshold, 150)}` : "", item.window ? short(item.window, 160) : ""].filter(Boolean);
  return `<p style="margin:12px 0 4px;font-size:15px;font-weight:600;line-height:1.6">${escape(short(item.metric, 90))}<span class="muted" style="font-weight:400;color:#52606d"> · ${escape(TITLES[item.notice.kind])}</span></p><p class="muted" style="margin:0;color:#52606d;font-size:14px;line-height:1.7">${facts.map(escape).join("<br>")}</p>`;
}
function groupHtml(group: Group): string {
  const lead = group.items[0];
  const action = group.recovered ? "无需处理；后续按有效观测继续监测。" : lead.action;
  const overflow = group.items.slice(TOP_METRICS);
  return `<tr><td class="divider" style="padding:24px 0;border-top:1px solid #dde3e8"><p class="muted" style="margin:0 0 4px;color:#52606d;font-size:12px;font-weight:600;letter-spacing:.04em">${escape(groupStatus(group))}${group.items.length > 1 ? ` · ${group.items.length} 项指标合并` : ""}</p><h2 style="margin:0 0 8px;font-size:20px;line-height:1.4;font-weight:650">${escape(short(group.resource, 110))}</h2><p style="margin:0;font-size:15px;line-height:1.7"><strong>${group.recovered ? "当前状态" : "下一步"}：</strong>${escape(short(action, 200))}</p>${!group.recovered && lead.impact ? `<p class="muted" style="margin:8px 0 0;color:#52606d;font-size:14px;line-height:1.7">${escape(lead.impact)}</p>` : ""}${group.items.slice(0, TOP_METRICS).map(metricHtml).join("")}${overflow.length ? `<p class="muted" style="margin:12px 0 0;color:#52606d;font-size:13px;line-height:1.7">同一对象另有 ${overflow.length} 项：${escape(overflow.slice(0, 3).map(i => short(i.metric, 36)).join("；") + (overflow.length > 3 ? "等" : ""))}。完整证据见纯文本版本。</p>` : ""}${lead.cost ? `<p class="muted" style="margin:12px 0 0;color:#52606d;font-size:13px;line-height:1.7">${escape(short(lead.cost, 220))}</p>` : ""}</td></tr>`;
}

/** Pure rendering: no recipients, secrets, remote images or network requests. */
export function renderMail(notices: Notice[], options: MailOptions): RenderedMail {
  const groups = groupsFor(notices);
  const headline = summary(groups);
  const title = options.exercise ? "演练" : notices.some(urgent) ? "需处理" : groups.every(g => g.recovered) ? "恢复摘要" : options.digest ? "监控摘要" : "监控通知";
  const subject = `[ghfind${options.exercise ? " E2E" : ""}] ${title}：${headline}`;
  const counts = countLine(notices, groups);
  // Dashboard paths are built only from a validated account ID, never notice text.
  const account = /^[a-f\d]{32}$/i.test(options.accountId) ? `https://dash.cloudflare.com/${options.accountId}` : "https://dash.cloudflare.com";
  const leadBilling = groups[0]?.items.some(item => billing(item.notice));
  const dashboard = leadBilling ? `${account}/billing/billable-usage` : account;
  const primaryLabel = leadBilling ? "核对 Cloudflare 费用" : "打开 Cloudflare 排查";
  const policy = "普通异常合并通知；严重功能故障或费用告警首次发生、升级时及时通知。持续问题按提醒周期汇总。";
  const exercise = options.exercise ? "这是一封本地/测试环境告警演练邮件，模拟数据不代表生产事故。" : "";
  const text = [subject, `${time(options.now)}\n${counts}`, exercise,
    ...groups.map(g => `${groupStatus(g)} · ${g.resource}\n${g.items.map(textEvidence).join("\n\n")}`),
    `${primaryLabel}：${dashboard}`, `排查说明：${RUNBOOK}`, policy].filter(Boolean).join("\n\n");
  const rest = groups.slice(TOP_GROUPS);
  const restHtml = rest.length ? `<tr><td class="divider" style="padding:20px 0;border-top:1px solid #dde3e8"><h2 style="margin:0 0 10px;font-size:17px;line-height:1.5">其他 ${rest.length} 个对象</h2>${rest.slice(0, OTHER_GROUPS).map(g => `<p style="margin:8px 0;font-size:14px;line-height:1.6"><strong>${escape(short(g.resource, 90))}</strong> · ${escape(groupStatus(g))} · ${g.items.length} 项<br><span class="muted" style="color:#52606d">${escape(short(g.items.map(i => i.metric).join("；"), 170))}</span></p>`).join("")}<p class="muted" style="margin:12px 0 0;color:#52606d;font-size:13px">${rest.length > OTHER_GROUPS ? `另有 ${rest.length - OTHER_GROUPS} 个对象未展开。` : ""}完整指标证据保留在邮件纯文本版本中。</p></td></tr>` : "";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escape(subject)}</title><style>:root{color-scheme:light dark}body{margin:0}table{border-collapse:collapse}a:focus-visible{outline:3px solid #197e6b;outline-offset:4px}@media(prefers-color-scheme:dark){.outer{background:#13181d!important}.sheet{background:#1c2228!important;color:#edf1f5!important}.muted{color:#b4bec8!important}.divider{border-color:#3b454e!important}.cta{background:#d3e8df!important;color:#142a23!important}.link{color:#9cd8c7!important}}@media(max-width:480px){.shell{padding:12px!important}.content{padding:24px 20px!important}h1{font-size:25px!important}}</style></head><body class="outer" style="margin:0;background:#eef1f4;color:#1d2833;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif"><div aria-hidden="true" style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escape(headline + "。" + counts)}</div><table role="presentation" width="100%" class="outer" style="background:#eef1f4"><tr><td class="shell" align="center" style="padding:32px 20px"><table role="presentation" width="100%" class="sheet" style="max-width:640px;background:#ffffff;color:#1d2833;table-layout:fixed"><tr><td class="content" style="padding:32px;overflow-wrap:anywhere;word-break:break-word"><p class="muted" style="margin:0 0 20px;font-size:13px;line-height:1.5;color:#52606d">ghfind / ${escape(title)}<br>${escape(time(options.now))}</p><h1 style="margin:0 0 12px;font-size:29px;line-height:1.35;font-weight:650;letter-spacing:-.02em">${escape(headline)}</h1><p class="muted" style="margin:0 0 24px;color:#52606d;font-size:14px;line-height:1.7">${escape(counts)}</p>${exercise ? `<p style="margin:0 0 24px;font-size:14px;line-height:1.7"><strong>演练：</strong>${escape(exercise)}</p>` : ""}<p style="margin:0 0 24px"><a class="cta" href="${escape(dashboard)}" style="display:inline-block;min-height:44px;box-sizing:border-box;padding:12px 18px;background:#174f43;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;line-height:20px">${escape(primaryLabel)}</a></p><table role="presentation" width="100%" style="table-layout:fixed">${groups.slice(0, TOP_GROUPS).map(groupHtml).join("")}${restHtml}</table><p class="muted divider" style="margin:0;padding-top:20px;border-top:1px solid #dde3e8;color:#52606d;font-size:12px;line-height:1.8">${escape(policy)}<br><a class="link" href="${RUNBOOK}" style="color:#176252;text-decoration:underline">查看监控口径与排查说明</a></p></td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}
