package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

type impactRegressionFixture struct {
	ExpectedFinalRange [2]float64       `json:"expected_final_range"`
	Metrics            RawMetrics       `json:"metrics"`
	ContribRepos       []ContribRepoAgg `json:"contrib_repos"`
	RecentPRs          []RecentPR       `json:"recent_prs"`
	Expected           struct {
		ImpactPrestigeScore float64   `json:"impact_prestige_score"`
		ImpactDepthRaw      float64   `json:"impact_depth_raw"`
		ImpactRepoCount     float64   `json:"impact_repo_count"`
		SubScores           SubScores `json:"sub_scores"`
		FinalScore          float64   `json:"final_score"`
	} `json:"expected"`
}

// TestImpactRegressionFixturesMatchNode runs the shared Node fixtures through
// the Go impact pipeline: the same impact and score must come out.
func TestImpactRegressionFixturesMatchNode(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate Go test file")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "src", "lib", "__tests__", "impact-regression-fixtures.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read impact regression fixtures: %v", err)
	}
	fixtures := map[string]impactRegressionFixture{}
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatalf("decode impact regression fixtures: %v", err)
	}
	for name, fixture := range fixtures {
		t.Run(name, func(t *testing.T) {
			m := fixture.Metrics
			login := strings.ToLower(m.Username)
			impact := ComputeImpactFromContribMap(fixture.ContribRepos, login)
			quality := ComputeImpactQualitySignals(fixture.RecentPRs, impact.ImpactPRCount, login, valueOrZero(m.WorkflowLandedImpactPRCount))
			m.MaxImpactRepoStars = impact.MaxImpactRepoStars
			m.ImpactPrestigeScore = &impact.ImpactPrestigeScore
			m.ImpactDepthRaw = impact.ImpactDepthRaw
			m.ImpactRepoCount = &impact.ImpactRepoCount
			m.ImpactCommitCount = &impact.ImpactCommitCount
			m.ImpactPRCount = impact.ImpactPRCount
			m.ImpactQualityCap = quality.ImpactQualityCap
			m.VerifiedImpactPRCount = &quality.VerifiedImpactPRCount
			m.CoreImpactPRCount = &quality.CoreImpactPRCount
			m.DocLikeImpactPRCount = &quality.DocLikeImpactPRCount
			m.UnverifiedImpactPRCount = &quality.UnverifiedImpactPRCount
			got := Score(m)

			want := fixture.Expected
			if impact.ImpactPrestigeScore != want.ImpactPrestigeScore || impact.ImpactDepthRaw != want.ImpactDepthRaw || impact.ImpactRepoCount != want.ImpactRepoCount {
				t.Fatalf("impact = %#v, want prestige %v depth %v repos %v", impact, want.ImpactPrestigeScore, want.ImpactDepthRaw, want.ImpactRepoCount)
			}
			if !reflect.DeepEqual(got.SubScores, want.SubScores) || got.FinalScore != want.FinalScore {
				t.Fatalf("score = %v %#v, want %v %#v", got.FinalScore, got.SubScores, want.FinalScore, want.SubScores)
			}
			if got.FinalScore < fixture.ExpectedFinalRange[0] || got.FinalScore > fixture.ExpectedFinalRange[1] {
				t.Fatalf("final score %v outside %v", got.FinalScore, fixture.ExpectedFinalRange)
			}
		})
	}
}

func TestDocLikeRepoNames(t *testing.T) {
	for _, repo := range []string{"socketio/socket.io", "socket.io", "foo/bar.org", "org/composite", "org/parasite", "org/homepage-builder-sdk"} {
		if isDocLikeRepo(repo) {
			t.Errorf("%s must not be doc-like", repo)
		}
	}
	for _, repo := range []string{"someone/someone.github.io", "bytedance/deerflow-website", "org/project-site", "org/project-homepage", "org/website", "org/site", "org/mywebsite"} {
		if !isDocLikeRepo(repo) {
			t.Errorf("%s must be doc-like", repo)
		}
	}
	for _, topic := range []string{"awesome", "course", "tutorial", "notes", "docs", "Awesome-List"} {
		if !isDocOrResourceRepo(ContribRepoAgg{Repo: "org/engine", Topics: []string{topic}}) {
			t.Errorf("topic %s must mark a resource repo", topic)
		}
	}
	if isDocOrResourceRepo(ContribRepoAgg{Repo: "org/engine", Topics: []string{"llm", "inference"}}) {
		t.Error("code topics must not mark a resource repo")
	}
}

func TestImpactExcludesMergesDocsAndOwnPrestige(t *testing.T) {
	agg := func(repo, owner string, stars, commits, merges, prs float64, topics ...string) ContribRepoAgg {
		return ContribRepoAgg{Repo: repo, OwnerLogin: owner, Stars: stars, Commits: commits, MergeCommits: merges, PRs: prs, Topics: topics}
	}
	authored := ComputeImpactFromContribMap([]ContribRepoAgg{agg("org/platform", "org", 24000, 6, 0, 0)}, "me")
	merged := ComputeImpactFromContribMap([]ContribRepoAgg{agg("org/platform", "org", 24000, 30, 24, 0)}, "me")
	if merged.ImpactPrestigeScore != authored.ImpactPrestigeScore || merged.ImpactDepthRaw != authored.ImpactDepthRaw {
		t.Fatalf("merge commits counted as work: %#v vs %#v", merged, authored)
	}
	if only := ComputeImpactFromContribMap([]ContribRepoAgg{agg("org/platform", "org", 24000, 12, 12, 0)}, "me"); only.ImpactPrestigeScore != 0 || only.ImpactDepthRaw != 0 {
		t.Fatalf("merge-only repo earned impact: %#v", only)
	}

	small := ComputeImpactFromContribMap([]ContribRepoAgg{
		agg("org/engine-website", "org", 4999, 40, 0, 10),
		agg("org/list", "org", 3000, 40, 0, 0, "awesome"),
	}, "me")
	if small.ImpactRepoCount != 0 {
		t.Fatalf("small doc/resource repos counted: %#v", small)
	}
	full := ComputeImpactFromContribMap([]ContribRepoAgg{agg("org/engine", "org", 8000, 40, 0, 10)}, "me")
	half := ComputeImpactFromContribMap([]ContribRepoAgg{agg("org/engine", "org", 8000, 40, 0, 10, "course")}, "me")
	if half.ImpactRepoCount != 1 || half.ImpactPrestigeScore >= full.ImpactPrestigeScore || half.ImpactDepthRaw >= full.ImpactDepthRaw {
		t.Fatalf("popular resource repo not halved: %#v vs %#v", half, full)
	}

	own := ComputeImpactFromContribMap([]ContribRepoAgg{agg("me/tool", "me", 30000, 200, 0, 0)}, "me")
	if own.ImpactRepoCount != 1 || own.ImpactPrestigeScore != 0 || own.ImpactDepthRaw != 0.75 {
		t.Fatalf("own repo impact = %#v, want depth 0.75 and no prestige", own)
	}
}

func TestApplyImpactRepoSignalsEstimatesMergeShare(t *testing.T) {
	got := ApplyImpactRepoSignals(
		[]ContribRepoAgg{{Repo: "Org/Engine", Commits: 50}, {Repo: "org/other", Commits: 9}},
		map[string]ImpactRepoSignal{"org/engine": {Topics: []string{"notes"}, SampledCommits: 100, MergeCommits: 30}},
	)
	if got[0].MergeCommits != 15 || !reflect.DeepEqual(got[0].Topics, []string{"notes"}) || got[1].MergeCommits != 0 || got[1].Topics != nil {
		t.Fatalf("signals = %#v", got)
	}
}

func TestImpactCapAllowsFiveVerifiedPRsWithScaledConfidence(t *testing.T) {
	docs, code := "docs: update guide", "fix scheduler"
	// Four doc-like PRs per core PR, one repository each.
	makePRs := func(n int) []RecentPR {
		prs := make([]RecentPR, n)
		for i := range prs {
			repo := "org/project-" + string(rune('a'+i))
			prs[i] = RecentPR{Title: &docs, Repo: &repo, RepoStars: 2000, Files: []string{"README.md"}}
			if i%5 == 0 {
				prs[i] = RecentPR{Title: &code, Repo: &repo, RepoStars: 2000, Files: []string{"internal/worker.go"}}
			}
		}
		return prs
	}
	if got := ComputeImpactQualitySignals(makePRs(4), 4, "alice", 0); got.ImpactQualityCap != nil {
		t.Fatalf("four PRs capped: %#v", got)
	}
	five := ComputeImpactQualitySignals(makePRs(5), 5, "alice", 0)
	twenty := ComputeImpactQualitySignals(makePRs(20), 20, "alice", 0)
	if five.ImpactQualityCap == nil || *five.ImpactQualityCap != 5.7 || twenty.ImpactQualityCap == nil || *five.ImpactQualityCap <= *twenty.ImpactQualityCap {
		t.Fatalf("five = %#v, twenty = %#v", five, twenty)
	}
}

func TestFetchImpactRepoSignalsQueriesEligibleReposAndCountsMerges(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		if request.URL.Path != "/graphql" || !strings.Contains(body.Query, "author: { id: $author }") ||
			!reflect.DeepEqual(body.Variables, map[string]any{"author": "U_me", "o0": "org", "n0": "engine"}) {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":{"r0":{"repositoryTopics":{"nodes":[{"topic":{"name":"awesome"}}]},
			"defaultBranchRef":{"target":{"history":{"nodes":[{"parents":{"totalCount":2}},{"parents":{"totalCount":1}},{"parents":{"totalCount":1}},{"parents":{"totalCount":1}}]}}}}}}`))
	}))
	defer server.Close()

	client := NewGitHubClient("test-token").withBaseURL(server.URL).withHTTPClient(server.Client())
	repos := []ContribRepoAgg{
		{Repo: "org/engine", OwnerLogin: "org", Stars: 9000, Commits: 40},
		{Repo: "org/tiny", OwnerLogin: "org", Stars: 50, Commits: 40},
		{Repo: "me/own", OwnerLogin: "me", Stars: 500, Commits: 40},
	}
	signals, err := client.fetchImpactRepoSignals(context.Background(), repos, "me", "U_me")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]ImpactRepoSignal{"org/engine": {Topics: []string{"awesome"}, SampledCommits: 4, MergeCommits: 1}}
	if !reflect.DeepEqual(signals, want) {
		t.Fatalf("signals = %#v, want %#v", signals, want)
	}
}
