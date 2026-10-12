import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { d1AsLibsqlClient, type D1DatabaseLike } from "@/lib/d1-client";
import { llmCompleter } from "@/lib/talent-match/extract";
import {
  failReport,
  failureCode,
  isFinalFailure,
  runAdvise,
  runExtract,
  runFinish,
  runMatch,
  runVerify,
  talentLlmConfigs,
  type CandidateParams,
} from "@/lib/talent-match/pipeline";

/**
 * ghfind-talent: the Talent Match report Workflow. Each stage of
 * src/lib/talent-match/pipeline.ts is one durable step, so a provider
 * hiccup retries only its own stage. Stages that see résumé-derived facts
 * mark their output sensitive; raw résumé text never leaves the extract step.
 */

interface Env {
  GHFIND_D1: D1DatabaseLike;
  GHFIND_FEED_D1?: D1DatabaseLike;
}

const LLM_STEP: WorkflowStepConfig = { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes" };
const DB_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "1 minute" };

/** A stage's outcome: a value, or a final failure code (no retry). */
type Outcome<T> = { ok: true; value: T } | { ok: false; code: string };

async function outcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (isFinalFailure(error)) return { ok: false, code: failureCode(error) };
    throw error; // transient: let the step retry
  }
}

export class TalentReportWorkflow extends WorkflowEntrypoint<Env, CandidateParams> {
  async run(event: Readonly<WorkflowEvent<CandidateParams>>, step: WorkflowStep) {
    const params = event.payload;
    const db = d1AsLibsqlClient(this.env.GHFIND_D1);
    const feed = this.env.GHFIND_FEED_D1 ? d1AsLibsqlClient(this.env.GHFIND_FEED_D1) : null;
    const fail = (code: string) =>
      step.do("fail", DB_STEP, async () => {
        await failReport(db, params.reportId, code, Date.now());
        return code;
      });

    try {
      const complete = llmCompleter(talentLlmConfigs());
      const extracted = await step.do("extract", { ...LLM_STEP, sensitive: "output" }, () =>
        outcome(() => runExtract(db, complete, params, Date.now())),
      );
      if (!extracted.ok) return { status: "failed", error: await fail(extracted.code) };

      const verified = await step.do("verify", { ...DB_STEP, sensitive: "output" }, () =>
        runVerify(db, params, extracted.value.extracted, SCORE_CACHE_VERSION, Date.now()),
      );
      const match = await step.do("match", DB_STEP, () => runMatch(db, feed, verified.profile, Date.now()));

      const advice = await step.do("advise", { ...LLM_STEP, sensitive: "output" }, () =>
        outcome(() => runAdvise(db, complete, params.reportId, verified.profile, match, Date.now())),
      );
      if (!advice.ok) return { status: "failed", error: await fail(advice.code) };

      await step.do("finish", DB_STEP, async () => {
        await runFinish(db, params, { ...verified, match, advice: advice.value }, Date.now());
        return true;
      });
      return { status: "done" };
    } catch (error) {
      console.error("talent_report_failed", { reportId: params.reportId, error: error instanceof Error ? error.message : String(error) });
      return { status: "failed", error: await fail("generation_failed") };
    }
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
