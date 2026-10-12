import type { Client } from "@libsql/client";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { auth, authConfigured } from "@/lib/auth";
import { normalizeGitHubUsername } from "@/lib/comments";
import { d1AsLibsqlClient, getD1Binding } from "@/lib/d1-client";
import type { CandidateParams } from "./pipeline";
import { STALE_REPORT_MS, type ReportRow } from "./store";

/**
 * Shared plumbing for the /api/talent-match routes: the signed-in account,
 * the core database, and the report Workflow, which lives on the
 * ghfind-talent Worker and is reached through a cross-script binding.
 */

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, { ...init, headers: { ...NO_STORE_HEADERS, ...init?.headers } });
}

export async function sessionUser(): Promise<{ githubId: number; login: string } | null> {
  const session = authConfigured() ? await auth() : null;
  const githubId = session?.user.githubId ?? 0;
  const login = normalizeGitHubUsername(session?.user.login ?? "");
  if (!Number.isSafeInteger(githubId) || githubId <= 0 || !login) return null;
  return { githubId, login };
}

export function coreDb(): Client | null {
  const binding = getD1Binding();
  return binding ? d1AsLibsqlClient(binding) : null;
}

/** The slice of a Workflow binding used to start reports. */
export interface ReportWorkflow {
  create(options: { id: string; params: CandidateParams }): Promise<unknown>;
}

/** TALENT_REPORT on the API Worker; absent on the legacy Next Worker and in dev without the talent Worker. */
export function reportWorkflow(): ReportWorkflow | null {
  try {
    const env = getCloudflareContext().env as { TALENT_REPORT?: ReportWorkflow };
    return env.TALENT_REPORT ?? null;
  } catch {
    return null;
  }
}

export const unavailable = () => jsonNoStore({ error: "talent_match_unavailable" }, { status: 503 });
export const signInRequired = () => jsonNoStore({ error: "sign_in_required" }, { status: 401 });

/** Public view of a report row: a run that stopped moving reads as failed. */
export function presentReport(report: ReportRow, now: number) {
  const stale = (report.status === "queued" || report.status === "running") && now - report.updatedAt > STALE_REPORT_MS;
  return {
    id: report.id,
    status: stale ? "failed" : report.status,
    report: report.status === "done" ? report.result : null,
    error: stale ? "stale" : report.error,
  };
}
