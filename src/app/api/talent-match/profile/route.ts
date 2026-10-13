import { coreDb, sessionUser, signInRequired, unavailable } from "@/lib/talent-match/http";
import { deleteTalentData } from "@/lib/talent-match/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Delete the account's Talent Match profile and every report. Phase 1 stores
 * no talent vectors, so there is nothing to remove from Vectorize yet; once
 * opted-in profiles are indexed (phase 2) their ids come back from
 * deleteTalentData and must be deleted there too.
 */
export async function DELETE() {
  const user = await sessionUser();
  if (!user) return signInRequired();
  const db = coreDb();
  if (!db) return unavailable();
  const vectorIds = await deleteTalentData(db, user.githubId);
  if (vectorIds.length) console.error("talent_vectors_not_deleted", { count: vectorIds.length });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
