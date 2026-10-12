import { NextRequest } from "next/server";
import { z } from "zod";
import { commentClientIp } from "@/lib/comments";
import { EMPLOYMENT_TYPES } from "@/lib/jobs";
import { checkTalentReportRateLimit, rateLimitHeaders } from "@/lib/redis";
import { coreDb, jsonNoStore, presentReport, reportWorkflow, sessionUser, signInRequired, unavailable } from "@/lib/talent-match/http";
import { candidateInputHash, failReport, jobsRevision, loadResumeText } from "@/lib/talent-match/pipeline";
import { admitReport, parseTokenBudget } from "@/lib/talent-match/quota";
import { MATCH_VERSION } from "@/lib/talent-match/score";
import { findDoneReport, insertQueuedReport, latestReport, monthFreeTokens, quotaCounts } from "@/lib/talent-match/store";
import { verifyTurnstile } from "@/lib/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("resume"), id: z.string().min(1).max(100) }),
    z.object({ kind: z.literal("profile") }),
  ]),
  preferences: z.object({
    location: z.string().trim().max(200),
    remote: z.boolean(),
    employment: z.array(z.enum(EMPLOYMENT_TYPES)).max(EMPLOYMENT_TYPES.length),
  }),
  turnstileToken: z.string().max(4096).nullable().optional(),
});

const REJECTIONS = {
  in_flight: 409,
  quota_exhausted: 429,
  budget_exhausted: 503,
} as const;

/** The caller's latest report (so the page can resume one in progress), or null. */
export async function GET() {
  const user = await sessionUser();
  if (!user) return signInRequired();
  const db = coreDb();
  if (!db) return unavailable();
  const report = await latestReport(db, user.githubId);
  return jsonNoStore({ latest: report ? presentReport(report, Date.now()) : null });
}

/**
 * Start a candidate report from a saved résumé plus the account's GitHub
 * evidence. Identical input under the current rules and job board returns
 * the finished report instead of spending quota. 202 with the report id;
 * the client polls GET /api/talent-match/reports/:id.
 */
export async function POST(request: NextRequest) {
  const user = await sessionUser();
  if (!user) return signInRequired();

  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return jsonNoStore({ error: "invalid_body" }, { status: 400 });
  }
  if (!(await verifyTurnstile(body.turnstileToken ?? null, commentClientIp(request.headers)))) {
    return jsonNoStore({ error: "turnstile_failed" }, { status: 403 });
  }
  const limit = await checkTalentReportRateLimit(user.githubId);
  if (!limit.success) {
    return jsonNoStore({ error: limit.unavailable ? "rate_limit_unavailable" : "rate_limited" }, {
      status: limit.unavailable ? 503 : 429,
      headers: rateLimitHeaders(limit),
    });
  }

  const db = coreDb();
  const workflow = reportWorkflow();
  if (!db || !workflow) return unavailable();

  const now = Date.now();
  const resumeText = await loadResumeText(db, user.githubId, body.source);
  if (!resumeText) return jsonNoStore({ error: "resume_missing" }, { status: 400 });
  const preferences = { ...body.preferences, employment: [...new Set(body.preferences.employment)] };
  const inputHash = candidateInputHash({ login: user.login, resumeText, preferences, jobsRevision: await jobsRevision(db) });

  const reused = await findDoneReport(db, user.githubId, inputHash, MATCH_VERSION);
  if (reused) return jsonNoStore({ id: reused, status: "done", reused: true });

  const [counts, tokens] = await Promise.all([quotaCounts(db, user.githubId, now), monthFreeTokens(db, now)]);
  const admission = admitReport({
    ...counts,
    byoKey: false,
    monthTokens: tokens,
    monthTokenBudget: parseTokenBudget(process.env.TALENT_MONTHLY_TOKEN_BUDGET),
  });
  if (!admission.ok) return jsonNoStore({ error: admission.reason }, { status: REJECTIONS[admission.reason] });

  const id = crypto.randomUUID();
  const queued = await insertQueuedReport(db, {
    id, githubId: user.githubId, kind: "candidate", inputHash, byoKey: false, matchVersion: MATCH_VERSION, now,
  });
  if (!queued) return jsonNoStore({ error: "in_flight" }, { status: 409 });

  try {
    await workflow.create({
      id,
      params: { reportId: id, githubId: user.githubId, login: user.login, source: body.source, preferences, inputHash, createdAt: now },
    });
  } catch (error) {
    console.error("talent_report_start_failed", error instanceof Error ? error.message : error);
    await failReport(db, id, "start_failed", Date.now());
    return unavailable();
  }
  return jsonNoStore({ id, status: "queued" }, { status: 202 });
}
