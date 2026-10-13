import { describe, expect, it } from "vitest";
import {
  computeImpactFromContribMap,
  computeImpactQualitySignals,
  type ContribRepoAgg,
} from "../github";
import { score } from "../score";
import type { RawMetrics, RecentPr } from "../types";
import fixtures from "./impact-regression-fixtures.json";

// Synthetic profiles calibrated to reproduce each account's pre-fix score
// (`before_final_score`) on the old impact rules. internal/backend shares this
// file, so `expected` pins TypeScript/Go parity of the whole impact pipeline.
interface ImpactRegressionFixture {
  before_final_score: number;
  expected_final_range: [number, number];
  metrics: Omit<
    RawMetrics,
    "max_impact_repo_stars" | "impact_pr_count" | "impact_depth_raw"
  >;
  contrib_repos: ContribRepoAgg[];
  recent_prs: RecentPr[];
  expected: {
    impact_prestige_score: number;
    impact_depth_raw: number;
    impact_repo_count: number;
    sub_scores: Record<string, number>;
    final_score: number;
  };
}

function scoreFixture(f: ImpactRegressionFixture) {
  const login = f.metrics.username.toLowerCase();
  const impact = computeImpactFromContribMap(f.contrib_repos, login);
  const quality = computeImpactQualitySignals(
    f.recent_prs,
    impact.impact_pr_count,
    login,
    f.metrics.workflow_landed_impact_pr_count ?? 0,
  );
  return { impact, scoring: score({ ...f.metrics, ...impact, ...quality }) };
}

describe("ecosystem impact regression fixtures", () => {
  for (const [name, raw] of Object.entries(fixtures)) {
    const fixture = raw as unknown as ImpactRegressionFixture;
    it(`${name}: ${fixture.before_final_score} → ${fixture.expected_final_range.join("–")}`, () => {
      const { impact, scoring } = scoreFixture(fixture);
      const [lo, hi] = fixture.expected_final_range;
      expect(scoring.final_score).toBeGreaterThanOrEqual(lo);
      expect(scoring.final_score).toBeLessThanOrEqual(hi);
      expect(impact.impact_prestige_score).toBe(fixture.expected.impact_prestige_score);
      expect(impact.impact_depth_raw).toBe(fixture.expected.impact_depth_raw);
      expect(impact.impact_repo_count).toBe(fixture.expected.impact_repo_count);
      expect(scoring.sub_scores).toEqual(fixture.expected.sub_scores);
      expect(scoring.final_score).toBe(fixture.expected.final_score);
    });
  }
});
