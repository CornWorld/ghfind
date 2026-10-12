import type { EmploymentType } from "@/lib/jobs";
import { readResumeLibraryFull } from "@/lib/resume";
import type { CandidateReport, Quota } from "./types";

/**
 * Browser calls for the /talent-match page. Every function resolves (never
 * throws) so components only branch on data: failures come back as
 * `{ error }` with the API's error code, or "network" when unreachable.
 */

export type ReportStatus = "queued" | "running" | "done" | "failed";

export interface ReportState {
  id: string;
  status: ReportStatus;
  report: CandidateReport | null;
  error: string | null;
}

export type ResumeSourceOption = { kind: "resume"; id: string; label: string; updatedAt: string } | { kind: "profile"; label: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function call<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(path, { credentials: "same-origin", ...init });
    if (res.status === 204) return { ok: true, value: undefined as T };
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { ok: false, error: body?.error ?? `http_${res.status}` };
    return { ok: true, value: body as T };
  } catch {
    return { ok: false, error: "network" };
  }
}

export const getQuota = () => call<Quota & { inFlight: boolean }>("/api/talent-match/quota");

export const getLatestReport = () => call<{ latest: ReportState | null }>("/api/talent-match/reports");

export const getReport = (id: string) => call<ReportState>(`/api/talent-match/reports/${encodeURIComponent(id)}`);

export interface CreateReportInput {
  source: { kind: "resume"; id: string } | { kind: "profile" };
  preferences: { location: string; remote: boolean; employment: EmploymentType[] };
  turnstileToken: string | null;
}

export const createReport = (input: CreateReportInput) =>
  call<{ id: string; status: ReportStatus; reused?: boolean }>("/api/talent-match/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const deleteTalentProfile = () => call<void>("/api/talent-match/profile", { method: "DELETE" });

/** Cloud-saved résumés (newest first) plus the reusable profile, the sources a report can read. */
export async function listResumeSources(): Promise<Result<ResumeSourceOption[]>> {
  const result = await call<{ data: string | null }>("/api/resumes");
  if (!result.ok) return result;
  if (!result.value.data) return { ok: true, value: [] };
  try {
    const library = readResumeLibraryFull(result.value.data);
    const resumes: ResumeSourceOption[] = [...library.resumes]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => ({ kind: "resume", id: r.id, label: r.name || r.basics.name || r.id, updatedAt: r.updatedAt }));
    return { ok: true, value: library.profile ? [...resumes, { kind: "profile", label: "" }] : resumes };
  } catch {
    return { ok: false, error: "resumes_unavailable" };
  }
}
