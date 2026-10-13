import { describe, expect, it } from "vitest";
import type { Notice } from "../engine";
import { renderMail } from "../mail";

const now = Date.UTC(2026, 9, 13, 3, 10);
const options = { accountId: "8f19bebe359e4ec1a24c68c5f49c1584", now, digest: true };
function notice(key: string, overrides: Partial<Notice> = {}): Notice {
  const resource = key.split(":")[1];
  return { id: key, key, kind: "open", severity: 1, delivered: [], attempts: 0, expiresAt: now + 86400000,
    text: `【性能 / 用量异常】${resource} / 请求数量\n影响对象：${resource}（Workers）\n观测值：1,234 次；调用数：300\n北京时间：2026-10-13 11:00 至 2026-10-13 11:05\n建议：检查近期部署。`, ...overrides };
}

describe("alert email", () => {
  it("presents old severe collection failures as a data gap, without implying overspend", () => {
    const mail = renderMail([notice("Monitor:collection:health", { severity: 2, text: "Cloudflare 用量采集未完成或数据尚未上报。不能确认账单安全。\n状态：Collection failed, delayed or exceeded bounded telemetry limits" })], options);
    expect(mail.subject).toBe("[ghfind] 监控摘要：用量数据暂不完整，请检查采集");
    for (const output of [mail.subject, mail.html, mail.text]) {
      expect(output).not.toContain("不能确认账单安全");
      expect(output).not.toContain("严重费用风险");
    }
    expect(mail.subject).not.toContain("严重");
    expect(mail.text).toContain("数据缺口本身不代表费用超支或业务故障");
    expect(mail.html).toContain("监控数据缺口");
    expect(mail.text).toContain("采集失败、上报延迟或达到采集上限");
  });

  it("retains safe source diagnosis and last complete collection without repeating evidence", () => {
    const row = notice("Monitor:collection:health", { evidence: {
      resource: "Cloudflare", metric: "采集缺口", value: "D1: API 限流", threshold: "持续 30 分钟", window: "10:35–11:10 UTC+8",
      action: "D1 限流：检查查询频率和下次重试结果。", cost: "最近完整采集：2026-10-13 10:30 UTC+8",
    } });
    const mail = renderMail([row], options);
    for (const output of [mail.text, mail.html]) {
      expect(output).toContain("D1: API 限流");
      expect(output).toContain(row.evidence!.action);
      expect(output).toContain(row.evidence!.cost);
    }
    const structured = notice("D1:db:read", { text: "duplicate old description", evidence: { resource: "db", metric: "reads", value: "1,000", window: "10:35–11:10 UTC+8", action: "Inspect-query-plan", cost: "estimate-only" } });
    const plain = renderMail([structured], options).text;
    expect(plain).not.toContain("duplicate old description");
    expect(plain.match(/Inspect-query-plan/g)).toHaveLength(1);
    expect(plain.match(/10:35–11:10 UTC\+8/g)).toHaveLength(1);
    expect(plain.match(/estimate-only/g)).toHaveLength(1);
  });

  it("translates collector categories while preserving each affected source", () => {
    const classifications = [
      ["D1", "rate limited; retry next scheduled window", "请求限流"],
      ["DO", "dataset unavailable or unsupported", "数据集不可用"],
      ["Workers", "access denied; check analytics token permissions", "权限不足"],
      ["Billing", "reconciliation unavailable", "账单对账暂不可用"],
      ["R2 storage", "request timed out", "采集请求超时"],
      ["Queues", "collection unavailable", "采集暂不可用"],
    ];
    for (const [source, reason, translation] of classifications) {
      const row = notice("Monitor:collection:health", { evidence: { resource: "Cloudflare", metric: "采集缺口", value: "持续 35 分钟", window: "10:35 起", action: `检查受影响的数据源：${source}: ${reason}。` } });
      const mail = renderMail([row], options);
      for (const output of [mail.html, mail.text]) {
        expect(output).toContain(`${source}: `);
        expect(output).toContain(translation);
        expect(output).not.toContain(reason);
      }
    }
  });

  it("groups one database's aggregate and SQL diagnostics without summing duplicate cost", () => {
    const rows = [notice("D1:db:rowsRead"), notice("D1:db:sql:abc"), notice("D1:db:sql:def")];
    const mail = renderMail(rows, options);
    expect(mail.html.match(/<h2[^>]*>db<\/h2>/g)).toHaveLength(1);
    expect(mail.html).toContain("3 项指标合并");
    expect(mail.text).toContain("1 个对象 · 3 项指标");
    expect(mail.subject).toBe("[ghfind] 监控摘要：db指标异常");
  });

  it("prioritizes a new critical service failure ahead of collection gaps and usage", () => {
    const rows = [notice("Monitor:collection:health", { severity: 2 }), notice("D1:db:read", { severity: 2 }), notice("Service:homepage:errors", { severity: 2 })];
    const before = structuredClone(rows);
    const mail = renderMail(rows, options);
    expect(mail.subject).toContain("需处理：homepage功能故障");
    expect(mail.html.indexOf(">homepage</h2>")).toBeLessThan(mail.html.indexOf(">db</h2>"));
    expect(mail.text).toContain("另有 2 个对象待排查");
    expect(rows).toEqual(before);
  });

  it("shows structured values, threshold, window, action and conservative cost", () => {
    const row = notice("account:burn", { severity: 2, evidence: {
      resource: "Cloudflare 账户", metric: "用量消耗速度", value: "15 分钟 $2.40 / 小时；60 分钟 $1.80 / 小时",
      threshold: "15 分钟 ≥ $2.00 / 小时，且 60 分钟 ≥ $1.00 / 小时", window: "2026-10-13 10:10–11:10 UTC+8",
      action: "先检查消耗最高的资源和近期部署。", impact: "已覆盖产品的消耗速度超出配置阈值。", cost: "套餐外单价估算，未扣套餐额度；非最终账单。",
    } });
    const mail = renderMail([row], options);
    for (const value of Object.values(row.evidence!)) {
      expect(mail.text).toContain(value);
      expect(mail.html).toContain(value);
    }
    expect(mail.html).toContain(`/billing/billable-usage"`);
    expect(mail.html).toContain("核对 Cloudflare 费用");
  });

  it("keeps recovered metrics separate from active ones on the same resource", () => {
    const mail = renderMail([notice("D1:db:read"), notice("D1:db:write", { severity: 0, kind: "recovery" })], options);
    expect(mail.subject).toBe("[ghfind] 监控摘要：db指标异常");
    expect(mail.html).toContain("需要排查");
    expect(mail.html).toContain("已恢复");
    expect(mail.html).not.toContain("所有服务正常");
    expect(mail.text).toContain("新增 1 / 恢复 1");
  });

  it("limits expanded groups but retains every notice and full evidence in plaintext", () => {
    const rows = Array.from({ length: 8 }, (_, i) => notice(`Workers:worker-${i}:requests`, { text: `【性能 / 用量异常】worker-${i} / marker-${i}\n影响对象：worker-${i}（Workers）\n观测值：${1000 + i} 次\n建议：unique-evidence-${i}` }));
    const mail = renderMail(rows, options);
    expect(mail.html.match(/下一步/g)).toHaveLength(3);
    expect(mail.html).toContain("其他 5 个对象");
    for (let i = 0; i < 8; i++) {
      expect(mail.html).toContain(`worker-${i}`);
      expect(mail.text).toContain(`unique-evidence-${i}`);
      expect(mail.text).toContain(`${1000 + i} 次`);
    }
  });

  it("bounds a full outbox's HTML while retaining all 64 notices in plaintext", () => {
    const rows = Array.from({ length: 64 }, (_, i) => notice(`Workers:resource-${i}:requests`, { text: `【异常】resource-${i} / metric-${i}\n影响对象：resource-${i}（Workers）\n观测值：1,000 次\n建议：action-${i}` }));
    const mail = renderMail(rows, options);
    expect(mail.html).toContain("其他 61 个对象");
    expect(mail.html).toContain("另有 56 个对象未展开");
    expect(new TextEncoder().encode(mail.html).byteLength).toBeLessThan(14000);
    for (let i = 0; i < 64; i++) expect(mail.text).toContain(`action-${i}`);
  });

  it("escapes metric content and builds links only from trusted paths", () => {
    const mail = renderMail([notice("D1:db:read", { text: '【异常】<img src=x onerror=alert(1)> / <script>alert(1)</script>\n影响对象：<svg onload=alert(2)>（D1）\n观测值：" onclick="alert(3)\n建议：javascript:alert(4)', evidence: undefined })], { ...options, accountId: 'evil.example/" onclick="alert(1)' });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<svg");
    expect(mail.html).not.toContain('onclick="');
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain('href="https://dash.cloudflare.com"');
    const links = [...mail.html.matchAll(/href="([^"]*)"/g)].map(match => match[1]);
    expect(links).toEqual(["https://dash.cloudflare.com", "https://github.com/hikariming/ghfind/tree/main/apps/cost-monitor#readme"]);
  });

  it("keeps header fields on a single line even with hostile structured text", () => {
    const row = notice("D1:db:read", { evidence: { resource: "db\r\nBcc: attacker@example.com", metric: "read", value: "1", window: "now", action: "check" } });
    const mail = renderMail([row], options);
    expect(mail.subject).not.toMatch(/[\r\n\u0000]/);
  });

  it("renders clear recovery and exercise subjects without duplicate alarm words", () => {
    const mail = renderMail([notice("D1:db:read", { kind: "recovery", severity: 0 })], options);
    expect(mail.subject).toBe("[ghfind] 恢复摘要：1 个受影响对象已恢复");
    const exercise = renderMail([notice("Service:homepage:errors", { severity: 2 })], { ...options, exercise: true });
    expect(exercise.subject).toContain("[ghfind E2E] 演练：");
    expect(exercise.text).toContain("模拟数据不代表生产事故");
  });

  it("uses inline fallback styles with dark and mobile enhancements, no remote assets", () => {
    const mail = renderMail([notice("D1:db:read")], options);
    expect(mail.html).toContain("prefers-color-scheme:dark");
    expect(mail.html).toContain("@media(max-width:480px)");
    expect(mail.html).toContain("min-height:44px");
    expect(mail.html).toContain('lang="zh-CN"');
    expect(mail.html).not.toMatch(/<img|<script|<iframe|<link\s/i);
    expect(mail.text).toContain("2026-10-13 11:10 UTC+8");
  });
});
