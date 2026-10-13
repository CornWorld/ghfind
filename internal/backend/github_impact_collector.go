package backend

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

const impactYearCap = 6

type graphContributionRepo struct {
	NameWithOwner  string  `json:"nameWithOwner"`
	StargazerCount float64 `json:"stargazerCount"`
	IsPrivate      bool    `json:"isPrivate"`
	IsFork         bool    `json:"isFork"`
	Owner          *struct {
		Login *string `json:"login"`
	} `json:"owner"`
}

type graphCommitContribNode struct {
	Contributions *struct {
		TotalCount float64 `json:"totalCount"`
	} `json:"contributions"`
	Repository *graphContributionRepo `json:"repository"`
}

func contributionRepoFromGraph(repo *graphContributionRepo) ContribRepoAgg {
	if repo == nil {
		return ContribRepoAgg{}
	}
	owner := ownerLoginFromRepo(repo.NameWithOwner)
	if repo.Owner != nil && repo.Owner.Login != nil && *repo.Owner.Login != "" {
		owner = *repo.Owner.Login
	}
	return ContribRepoAgg{Repo: repo.NameWithOwner, Stars: repo.StargazerCount, IsPrivate: repo.IsPrivate, IsFork: repo.IsFork, OwnerLogin: owner}
}

// fetchCommitContribReposByYear mirrors the Node collector's bounded GraphQL
// aliases. GraphQL permits each contribution window to cover only one year.
func (c *GitHubClient) fetchCommitContribReposByYear(ctx context.Context, username string, years []int) ([]ContribRepoAgg, error) {
	unique := map[int]bool{}
	for _, year := range years {
		unique[year] = true
	}
	capped := make([]int, 0, len(unique))
	for year := range unique {
		capped = append(capped, year)
	}
	sort.Slice(capped, func(i, j int) bool { return capped[i] > capped[j] })
	if len(capped) > impactYearCap {
		capped = capped[:impactYearCap]
	}
	if len(capped) == 0 {
		return nil, nil
	}
	perYear, err := c.fetchCommitContribsBatch(ctx, username, capped)
	if errors.Is(err, ErrGitHubResourceLimit) && len(capped) > 1 {
		perYear = make([][]graphCommitContribNode, len(capped))
		for index, year := range capped {
			single, singleErr := c.fetchCommitContribsBatch(ctx, username, []int{year})
			if errors.Is(singleErr, ErrGitHubResourceLimit) {
				continue // Node behaviour: one pathological year does not fail the scan.
			}
			if singleErr != nil {
				return nil, singleErr
			}
			perYear[index] = single[0]
		}
	} else if err != nil {
		return nil, err
	}

	byRepo := map[string]ContribRepoAgg{}
	yearsByRepo := map[string]map[int]bool{}
	order := []string{}
	for index, nodes := range perYear {
		for _, node := range nodes {
			if node.Repository == nil || node.Repository.NameWithOwner == "" {
				continue
			}
			key := node.Repository.NameWithOwner
			current, found := byRepo[key]
			if !found {
				current = contributionRepoFromGraph(node.Repository)
				order = append(order, key)
			}
			current.Stars = max(current.Stars, node.Repository.StargazerCount)
			if node.Contributions != nil {
				current.Commits += node.Contributions.TotalCount
			}
			byRepo[key] = current
			if yearsByRepo[key] == nil {
				yearsByRepo[key] = map[int]bool{}
			}
			yearsByRepo[key][capped[index]] = true
		}
	}
	result := make([]ContribRepoAgg, 0, len(order))
	for _, key := range order {
		current := byRepo[key]
		current.ActiveYears = float64(len(yearsByRepo[key]))
		result = append(result, current)
	}
	return result, nil
}

func (c *GitHubClient) fetchCommitContribsBatch(ctx context.Context, username string, years []int) ([][]graphCommitContribNode, error) {
	declarations := []string{"$login: String!"}
	aliases := []string{}
	variables := map[string]any{"login": username}
	for index, year := range years {
		declarations = append(declarations, fmt.Sprintf("$from%d: DateTime!, $to%d: DateTime!", index, index))
		aliases = append(aliases, fmt.Sprintf("y%d: contributionsCollection(from: $from%d, to: $to%d) { ...RepoContribs }", index, index, index))
		variables[fmt.Sprintf("from%d", index)] = fmt.Sprintf("%d-01-01T00:00:00Z", year)
		variables[fmt.Sprintf("to%d", index)] = fmt.Sprintf("%d-12-31T23:59:59Z", year)
	}
	query := "query(" + strings.Join(declarations, ", ") + `) {
  user(login: $login) { ` + strings.Join(aliases, " ") + ` }
}
fragment RepoContribs on ContributionsCollection {
  commitContributionsByRepository(maxRepositories: 100) {
    contributions { totalCount }
    repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
  }
}`
	var result struct {
		User map[string]struct {
			CommitContributionsByRepository []graphCommitContribNode `json:"commitContributionsByRepository"`
		} `json:"user"`
	}
	if err := c.graphql(ctx, query, variables, &result); err != nil {
		return nil, err
	}
	if result.User == nil {
		return nil, fmt.Errorf("GitHub commit contributions: %w", ErrGitHubUnavailable)
	}
	pages := make([][]graphCommitContribNode, len(years))
	for index := range years {
		pages[index] = result.User[fmt.Sprintf("y%d", index)].CommitContributionsByRepository
	}
	return pages, nil
}

const (
	// impactSignalRepoCap bounds the repos (by stars) whose topics and merge
	// share are fetched; mergeCommitSample is the per-repo commit sample.
	impactSignalRepoCap = 20
	mergeCommitSample   = 100
)

type ImpactRepoSignal struct {
	Topics         []string
	SampledCommits float64
	MergeCommits   float64
}

// ApplyImpactRepoSignals mirrors applyImpactRepoSignals in src/lib/github.ts:
// the sampled merge share is applied to the contribution-graph total.
func ApplyImpactRepoSignals(repos []ContribRepoAgg, signals map[string]ImpactRepoSignal) []ContribRepoAgg {
	result := make([]ContribRepoAgg, 0, len(repos))
	for _, repo := range repos {
		if signal, ok := signals[strings.ToLower(repo.Repo)]; ok {
			share := 0.0
			if signal.SampledCommits > 0 {
				share = signal.MergeCommits / signal.SampledCommits
			}
			repo.Topics = signal.Topics
			repo.MergeCommits = roundJS(repo.Commits * share)
		}
		result = append(result, repo)
	}
	return result
}

// fetchImpactRepoSignals mirrors the Node collector: one aliased GraphQL
// request with topics and the user's latest default-branch commits (with
// parent counts) for repos that can earn ecosystem impact. Best-effort: only a
// rate limit fails the scan; other errors leave impact on name-only rules.
func (c *GitHubClient) fetchImpactRepoSignals(ctx context.Context, repos []ContribRepoAgg, loginLower, authorNodeID string) (map[string]ImpactRepoSignal, error) {
	signals := map[string]ImpactRepoSignal{}
	candidates := []ContribRepoAgg{}
	for _, repo := range repos {
		if passesImpactRepoGates(repo, loginLower) && strings.Contains(repo.Repo, "/") {
			candidates = append(candidates, repo)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Stars != candidates[j].Stars {
			return candidates[i].Stars > candidates[j].Stars
		}
		return candidates[i].Repo < candidates[j].Repo
	})
	if len(candidates) > impactSignalRepoCap {
		candidates = candidates[:impactSignalRepoCap]
	}
	if authorNodeID == "" || len(candidates) == 0 {
		return signals, nil
	}
	declarations := []string{"$author: ID!"}
	aliases := []string{}
	variables := map[string]any{"author": authorNodeID}
	for index, repo := range candidates {
		owner, name, _ := strings.Cut(repo.Repo, "/")
		declarations = append(declarations, fmt.Sprintf("$o%d: String!, $n%d: String!", index, index))
		aliases = append(aliases, fmt.Sprintf("r%d: repository(owner: $o%d, name: $n%d) { ...ImpactRepoSignals }", index, index, index))
		variables[fmt.Sprintf("o%d", index)] = owner
		variables[fmt.Sprintf("n%d", index)] = name
	}
	query := "query(" + strings.Join(declarations, ", ") + ") { " + strings.Join(aliases, " ") + ` }
fragment ImpactRepoSignals on Repository {
  repositoryTopics(first: 20) { nodes { topic { name } } }
  defaultBranchRef { target { ... on Commit {
    history(first: ` + fmt.Sprint(mergeCommitSample) + `, author: { id: $author }) { nodes { parents(first: 2) { totalCount } } }
  } } }
}`
	var result map[string]*struct {
		RepositoryTopics *struct {
			Nodes []*struct {
				Topic *struct {
					Name string `json:"name"`
				} `json:"topic"`
			} `json:"nodes"`
		} `json:"repositoryTopics"`
		DefaultBranchRef *struct {
			Target *struct {
				History *struct {
					Nodes []*struct {
						Parents *struct {
							TotalCount float64 `json:"totalCount"`
						} `json:"parents"`
					} `json:"nodes"`
				} `json:"history"`
			} `json:"target"`
		} `json:"defaultBranchRef"`
	}
	if err := c.graphql(ctx, query, variables, &result); err != nil {
		if errors.Is(err, ErrGitHubRateLimited) {
			return nil, err
		}
		return signals, nil
	}
	for index, repo := range candidates {
		node := result[fmt.Sprintf("r%d", index)]
		if node == nil {
			continue
		}
		signal := ImpactRepoSignal{Topics: []string{}}
		if node.RepositoryTopics != nil {
			for _, topic := range node.RepositoryTopics.Nodes {
				if topic != nil && topic.Topic != nil {
					signal.Topics = append(signal.Topics, topic.Topic.Name)
				}
			}
		}
		if node.DefaultBranchRef != nil && node.DefaultBranchRef.Target != nil && node.DefaultBranchRef.Target.History != nil {
			for _, commit := range node.DefaultBranchRef.Target.History.Nodes {
				signal.SampledCommits++
				if commit != nil && commit.Parents != nil && commit.Parents.TotalCount > 1 {
					signal.MergeCommits++
				}
			}
		}
		signals[strings.ToLower(repo.Repo)] = signal
	}
	return signals, nil
}

func (c *GitHubClient) fetchMergedPRContribRepos(ctx context.Context, username string, maxPRs int) ([]ContribRepoAgg, error) {
	byRepo := map[string]ContribRepoAgg{}
	yearsByRepo := map[string]map[int]bool{}
	order := []string{}
	var after *string
	counted := 0
	for counted < maxPRs {
		count := maxPRs - counted
		if count > 100 {
			count = 100
		}
		var result struct {
			User *struct {
				PullRequests *struct {
					Nodes []struct {
						MergedAt   *string                `json:"mergedAt"`
						Repository *graphContributionRepo `json:"repository"`
					} `json:"nodes"`
					PageInfo *struct {
						HasNextPage bool    `json:"hasNextPage"`
						EndCursor   *string `json:"endCursor"`
					} `json:"pageInfo"`
				} `json:"pullRequests"`
			} `json:"user"`
		}
		query := `query($login: String!, $count: Int!, $after: String) {
  user(login: $login) {
    pullRequests(first: $count, states: MERGED, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { mergedAt repository { nameWithOwner stargazerCount isPrivate isFork owner { login } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`
		if err := c.graphql(ctx, query, map[string]any{"login": username, "count": count, "after": after}, &result); err != nil {
			return nil, err
		}
		if result.User == nil || result.User.PullRequests == nil {
			return nil, fmt.Errorf("GitHub merged PR data: %w", ErrGitHubUnavailable)
		}
		for _, node := range result.User.PullRequests.Nodes {
			if node.Repository == nil || node.Repository.NameWithOwner == "" {
				continue
			}
			key := node.Repository.NameWithOwner
			current, found := byRepo[key]
			if !found {
				current = contributionRepoFromGraph(node.Repository)
				order = append(order, key)
			}
			current.Stars = max(current.Stars, node.Repository.StargazerCount)
			current.PRs++
			counted++
			byRepo[key] = current
			if merged, ok := parseTimestamp(node.MergedAt); ok {
				if yearsByRepo[key] == nil {
					yearsByRepo[key] = map[int]bool{}
				}
				yearsByRepo[key][merged.Year()] = true
			}
		}
		pageInfo := result.User.PullRequests.PageInfo
		if pageInfo == nil || !pageInfo.HasNextPage || pageInfo.EndCursor == nil || *pageInfo.EndCursor == "" {
			break
		}
		after = pageInfo.EndCursor
	}
	result := make([]ContribRepoAgg, 0, len(order))
	for _, key := range order {
		current := byRepo[key]
		current.ActiveYears = float64(len(yearsByRepo[key]))
		result = append(result, current)
	}
	return result, nil
}

// AccountAgeYears matches the two-decimal calculation from src/lib/github.ts.
func accountAgeYears(createdAt *string, now time.Time) float64 {
	created, ok := parseTimestamp(createdAt)
	if !ok {
		return 0
	}
	return roundJS(now.Sub(created).Hours()/24/365.25*100) / 100
}

func boundedContributionYearsActive(years []int, createdAt *string, now time.Time) float64 {
	active := map[int]bool{}
	for _, year := range years {
		active[year] = true
	}
	if len(active) == 0 {
		return 0
	}
	created, ok := parseTimestamp(createdAt)
	if !ok {
		return float64(len(active))
	}
	if now.Year() < created.Year() {
		return 0
	}
	count := 0.0
	for year := range active {
		if year >= created.Year() && year <= now.Year() {
			count++
		}
	}
	return count
}
