import { describe, expect, it } from "vitest";
import { acknowledge, emptyState, MAX_NOTICES, WINDOW_MS } from "../engine";
import { acknowledgeCollection, billingDue, COLLECTION_KEY, COLLECTION_REMINDER_MS, observeCollection } from "../collection-health";

const base = 1_800_000_000_000;
function failure(state: ReturnType<typeof emptyState>, minutes: number, reason = "D1: rate limited") {
  observeCollection(state, [reason], base + minutes * 60_000, base + minutes * 60_000 - 3 * WINDOW_MS);
}
function success(state: ReturnType<typeof emptyState>, minutes: number) {
  observeCollection(state, [], base + minutes * 60_000, base + minutes * 60_000 - 3 * WINDOW_MS);
}
function delivered(state: ReturnType<typeof emptyState>, minutes: number) {
  const notice = state.outbox[0];
  notice.delivered = ["recipient@example.org"];
  acknowledgeCollection(state, notice, base + minutes * 60_000);
  acknowledge(state, notice, base + minutes * 60_000);
}

describe("persistent collection incident", () => {
  it("does not send transient missing telemetry or label it a spending incident", () => {
    const state = emptyState();
    for (const minute of [0, 5, 10, 15, 20, 25]) failure(state, minute);
    expect(state.outbox).toHaveLength(0);
    failure(state, 30);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]).toMatchObject({ key: COLLECTION_KEY, severity: 1, kind: "open" });
    expect(state.outbox[0].text).toContain("不是已确认的费用超支");
    expect(state.outbox[0].text).not.toContain("不能确认账单安全");
  });

  it("retains dedupe through restarts and changing failure reasons for twelve hours", () => {
    let state = emptyState();
    for (let minute = 0; minute <= 30; minute += 5) failure(state, minute);
    delivered(state, 60);
    state = JSON.parse(JSON.stringify(state));
    for (let minute = 65; minute < 780; minute += 5) failure(state, minute, "Workers: delayed");
    expect(state.outbox).toHaveLength(0);
    failure(state, 780);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0].kind).toBe("reminder");
    expect(state.collection!.since).toBe(base);
    expect(COLLECTION_REMINDER_MS).toBe(12 * 3600_000);
  });

  it("does not count repeated runs in one five-minute interval as distinct failures", () => {
    const state = emptyState();
    failure(state, 0); failure(state, 0); failure(state, 1); failure(state, 2);
    expect(state.collection!.failures).toBe(1);
    expect(state.outbox).toHaveLength(0);
  });

  it("withdraws stale pending failure on success and confirms recovery on two distinct windows", () => {
    const state = emptyState();
    failure(state, 0); failure(state, 15); failure(state, 30);
    success(state, 35);
    expect(state.outbox).toHaveLength(0);
    expect(state.collection!.since).toBe(base);
    success(state, 35);
    expect(state.collection!.good).toBe(1);
    success(state, 40);
    expect(state.collection!.since).toBe(0);
    expect(state.outbox).toHaveLength(0);
    failure(state, 45);
    expect(state.collection!.since).toBe(base + 45 * 60_000);
    expect(state.outbox).toHaveLength(0);
  });

  it("keeps an acknowledged incident across a single good window rather than reopening on flaps", () => {
    const state = emptyState();
    failure(state, 0); failure(state, 15); failure(state, 30); delivered(state, 60);
    success(state, 65); failure(state, 70);
    expect(state.collection!.notified).toBe(true);
    expect(state.outbox).toHaveLength(0);
  });

  it("refreshes pending evidence without repeating successful recipients", () => {
    const state = emptyState();
    failure(state, 0); failure(state, 15); failure(state, 30);
    state.outbox[0].delivered = ["one@example.org"];
    const id = state.outbox[0].id;
    failure(state, 35, "Workers: permission denied");
    expect(state.outbox[0].id).toBe(id);
    expect(state.outbox[0].delivered).toEqual(["one@example.org"]);
    expect(state.outbox[0].text).toContain("Workers: permission denied");
  });

  it("discards stateless legacy critical notices during migration", () => {
    const state = emptyState();
    state.outbox.push({ id: "legacy", key: COLLECTION_KEY, kind: "open", severity: 2, text: "legacy", delivered: [], attempts: 0, expiresAt: base + 86400_000 });
    failure(state, 0);
    expect(state.outbox).toHaveLength(0);
    expect(state.collection!.notified).toBe(false);
  });

  it("does not resend accepted recipients when a partial delivery flaps through one good window", () => {
    const state = emptyState();
    failure(state, 0); failure(state, 15); failure(state, 30);
    state.outbox[0].delivered = ["one@example.org"];
    success(state, 35);
    expect(state.outbox).toHaveLength(0);
    failure(state, 40);
    expect(state.outbox[0].delivered).toEqual(["one@example.org"]);
    expect(state.outbox[0].kind).toBe("open");
    success(state, 45); success(state, 50);
    expect(state.collection!.acceptedRecipients).toEqual([]);
  });

  it("bounds the outbox and resumes a delayed notice when room becomes available", () => {
    const state = emptyState(); failure(state, 0);
    state.outbox = Array.from({ length: MAX_NOTICES }, (_, index) => ({ id: String(index), key: `D1:${index}:read`, kind: "open" as const, severity: 1, text: "test", delivered: [], attempts: 0, expiresAt: base + 86400_000 }));
    failure(state, 15); failure(state, 30);
    expect(state.outbox).toHaveLength(MAX_NOTICES);
    state.outbox.pop(); failure(state, 35);
    expect(state.outbox).toHaveLength(MAX_NOTICES);
    expect(state.outbox.at(-1)!.key).toBe(COLLECTION_KEY);
  });

  it("reconciles billing every six hours and retries failures at most hourly", () => {
    const state = emptyState();
    expect(billingDue(state, base)).toBe(true);
    state.lastBillingAttempt = base;
    expect(billingDue(state, base + WINDOW_MS)).toBe(false);
    expect(billingDue(state, base + 3600_000)).toBe(true);
    state.lastBilling = base + 3600_000;
    expect(billingDue(state, base + 6 * 3600_000)).toBe(false);
    expect(billingDue(state, base + 7 * 3600_000)).toBe(true);
  });
});
