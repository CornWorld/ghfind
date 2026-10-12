import { NextRequest } from "next/server";
import { coreDb, jsonNoStore, sessionUser, signInRequired, unavailable } from "@/lib/talent-match/http";
import { STALE_REPORT_MS, getOwnReport } from "@/lib/talent-match/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Report status for its owner; the CandidateReport once done. Others get 404. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await sessionUser();
  if (!user) return signInRequired();
  const db = coreDb();
  if (!db) return unavailable();
  const { id } = await params;
  const report = await getOwnReport(db, id, user.githubId);
  if (!report) return jsonNoStore({ error: "not_found" }, { status: 404 });
  // A run that stopped moving is reported as failed; the next submission
  // marks the row itself (store.insertQueuedReport).
  const stale = (report.status === "queued" || report.status === "running") && Date.now() - report.updatedAt > STALE_REPORT_MS;
  return jsonNoStore({
    id: report.id,
    status: stale ? "failed" : report.status,
    report: report.status === "done" ? report.result : null,
    error: stale ? "stale" : report.error,
  });
}
