"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, BookOpen, Code2, FileText, FlaskConical, GitPullRequest, GraduationCap, Globe, Hammer, RefreshCw, Sparkles, Star, Trash2, Upload } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { DIMENSIONS } from "@/lib/dimensions";
import { readResumeLibrary, RESUME_STORAGE_KEY } from "@/lib/resume";
import { SUBSCORE_MAX } from "@/lib/score-presentation";
import { MOCK_CANDIDATE_REPORT } from "@/lib/talent-match/mock";
import { CANDIDATE_STAGES, type CandidateReport, type Cost, type GrowthKind, type JobMatch, type ProfileItem } from "@/lib/talent-match/types";
import type { SubScoreKey } from "@/lib/types";
import { Bar, Breakdown, Card, Chip, FitScore, SourceBadge, StageProgress, fieldClass, primaryButton, secondaryButton, type Copy } from "./parts";

const DIMENSION_LABELS: Record<SubScoreKey, [string, string]> = {
  account_maturity: ["账号成熟度", "Account maturity"],
  original_project_quality: ["原创项目质量", "Original project quality"],
  contribution_quality: ["贡献质量", "Contribution quality"],
  ecosystem_impact: ["生态影响力", "Ecosystem impact"],
  community_influence: ["社区影响力", "Community influence"],
  activity_authenticity: ["活跃真实性", "Activity authenticity"],
};

const STAGE_LABELS: Record<(typeof CANDIDATE_STAGES)[number], [string, string]> = {
  normalize: ["整理简历、GitHub 与网站资料", "Collecting résumé, GitHub and website"],
  extract: ["抽取结构化人才画像", "Extracting a structured talent profile"],
  verify: ["用 GitHub 数据验证能力", "Verifying skills against GitHub evidence"],
  match: ["匹配岗位并计算差距", "Matching roles and measuring gaps"],
  advise: ["生成成长建议", "Writing your growth plan"],
};

const GROWTH_ICONS: Record<GrowthKind, typeof Code2> = {
  open_source: GitPullRequest,
  skill: BookOpen,
  research: FlaskConical,
  education: GraduationCap,
  portfolio: Hammer,
};

const STAGE_MS = 700;

export type CandidateInputs = { github: string | null; website: string; pdfName: string | null; useResume: boolean };

export function CandidatePanel({
  copy,
  login,
  handoff,
  canGenerate,
  onGenerated,
  onSignIn,
}: {
  copy: Copy;
  /** Signed-in GitHub login, or null when signed out. */
  login: string | null;
  /** GitHub handle passed in from the home search box, if any. */
  handoff: string | null;
  /** False when signed out or out of quota. */
  canGenerate: boolean;
  onGenerated: () => void;
  onSignIn: () => void;
}) {
  const { c } = copy;
  const [inputs, setInputs] = useState<CandidateInputs>({ github: null, website: "", pdfName: null, useResume: true });
  const [localResumes, setLocalResumes] = useState(0);
  const [stage, setStage] = useState<number | null>(null);
  const [report, setReport] = useState<CandidateReport | null>(null);

  useEffect(() => {
    // Read after hydration: résumé builder data lives in localStorage.
    Promise.resolve().then(() => {
      try { setLocalResumes(readResumeLibrary(localStorage.getItem(RESUME_STORAGE_KEY)).length); } catch { /* storage unavailable */ }
    });
  }, []);

  useEffect(() => {
    if (stage === null) return;
    const timer = setTimeout(() => {
      if (stage + 1 < CANDIDATE_STAGES.length) {
        setStage(stage + 1);
      } else {
        setStage(null);
        setReport(MOCK_CANDIDATE_REPORT);
        onGenerated();
      }
    }, STAGE_MS);
    return () => clearTimeout(timer);
  }, [stage, onGenerated]);

  // Until edited, the GitHub field follows the home-search handoff, then the
  // signed-in account.
  const github = inputs.github ?? handoff ?? login ?? "";
  const hasSource = Boolean(github.trim() || inputs.website.trim() || inputs.pdfName || (inputs.useResume && localResumes > 0));

  if (stage !== null) {
    return (
      <Card title={c("正在生成报告", "Generating your report")}>
        <StageProgress stages={CANDIDATE_STAGES.map((s) => c(...STAGE_LABELS[s]))} current={stage} />
        <p className="mt-5 text-xs text-zinc-500">{c("通常需要 30–60 秒，可以离开页面，完成后在这里查看。", "Usually 30–60 seconds. You can leave; the report will be here when it's done.")}</p>
      </Card>
    );
  }

  if (report) {
    return <CandidateReportView report={report} copy={copy} onReset={() => setReport(null)} />;
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
      <Card title={c("你的资料", "Your material")}>
        <div className="space-y-4">
          <label className="flex items-start gap-3 rounded-xl border border-white/10 p-3">
            <input type="checkbox" className="mt-1" checked={inputs.useResume} onChange={(e) => setInputs({ ...inputs, useResume: e.target.checked })} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium text-zinc-100"><FileText className="h-4 w-4" aria-hidden="true" />{c("使用「我的简历」中的数据", "Use data from My résumé")}</span>
              <span className="mt-1 block text-xs text-zinc-500">
                {localResumes > 0
                  ? c(`检测到 ${localResumes} 份简历，将使用最近编辑的一份。`, `${localResumes} résumé(s) found; the most recently edited one is used.`)
                  : <>{c("还没有简历。", "No résumé yet. ")}<Link href="/resume" prefetch={false} className="underline underline-offset-2 hover:text-zinc-300">{c("去创建", "Create one")}</Link></>}
              </span>
            </span>
          </label>

          <div>
            <p className="mb-1.5 text-sm font-medium text-zinc-200">{c("或上传 PDF 简历", "Or upload a PDF résumé")}</p>
            <div className="flex flex-wrap items-center gap-3">
              {/* Styled label instead of ::file-selector-button, which has no light-theme mapping. */}
              <label htmlFor="tm-pdf" className={`${secondaryButton} cursor-pointer`}>
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />{c("选择文件", "Choose file")}
              </label>
              <span className="min-w-0 truncate text-sm text-zinc-400">{inputs.pdfName ?? c("未选择文件", "No file chosen")}</span>
              <input
                id="tm-pdf"
                type="file"
                accept="application/pdf"
                className="sr-only"
                onChange={(e) => setInputs({ ...inputs, pdfName: e.target.files?.[0]?.name ?? null })}
              />
            </div>
            <p className="mt-1 text-xs text-zinc-500">{c("PDF 在你的浏览器内解析，原文件不会上传。", "The PDF is parsed in your browser; the file itself is never uploaded.")}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="tm-github" className="mb-1.5 block text-sm font-medium text-zinc-200">GitHub</label>
              <input id="tm-github" className={fieldClass} placeholder="octocat" value={github} onChange={(e) => setInputs({ ...inputs, github: e.target.value })} />
            </div>
            <div>
              <label htmlFor="tm-site" className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-zinc-200"><Globe className="h-3.5 w-3.5" aria-hidden="true" />{c("个人网站 / 博客", "Website / blog")}</label>
              <input id="tm-site" className={fieldClass} placeholder="https://" value={inputs.website} onChange={(e) => setInputs({ ...inputs, website: e.target.value })} />
            </div>
          </div>
        </div>
      </Card>

      <Card title={c("会得到什么", "What you get")}>
        <ul className="space-y-2.5 text-sm text-zinc-300">
          <li>{c("· 多维人才画像，区分「已验证」与「自述」", "· A multi-dimension profile, verified vs claimed")}</li>
          <li>{c("· 匹配岗位与匹配度拆解", "· Matching roles with a score breakdown")}</li>
          <li>{c("· 缺口分析与补齐成本", "· Gaps and the cost to close them")}</li>
          <li>{c("· 成长路线：开源贡献、技能、科研、学历", "· A growth plan: open source, skills, research, education")}</li>
        </ul>
        <div className="mt-5">
          {login ? (
            <button type="button" className={`${primaryButton} w-full`} disabled={!canGenerate || !hasSource} onClick={() => setStage(0)}>
              <Sparkles className="h-4 w-4" aria-hidden="true" />{c("生成报告", "Generate report")}
            </button>
          ) : (
            <button type="button" className={`${primaryButton} w-full`} onClick={onSignIn}>{c("登录 GitHub 后生成", "Sign in with GitHub to generate")}</button>
          )}
          {login && !hasSource && <p className="mt-2 text-xs text-zinc-500">{c("至少提供一种资料。", "Provide at least one source.")}</p>}
          <button type="button" className={`${secondaryButton} mt-2 w-full`} onClick={() => setReport(MOCK_CANDIDATE_REPORT)}>{c("查看示例报告", "View a sample report")}</button>
        </div>
      </Card>
    </div>
  );
}

const costLabel = (cost: Cost, c: Copy["c"]) => ({ low: c("低成本", "Low effort"), medium: c("中等成本", "Medium effort"), high: c("高成本", "High effort") })[cost];
const reachLabel = (reach: JobMatch["reach"], c: Copy["c"]) => ({ high: c("可达性高", "Highly reachable"), medium: c("可达性中", "Reachable"), low: c("可达性低", "Stretch") })[reach];

function CandidateReportView({ report, copy, onReset }: { report: CandidateReport; copy: Copy; onReset: () => void }) {
  const { c, tx } = copy;
  const { profile } = report;
  const [optedIn, setOptedIn] = useState(false);
  const matches = [...report.matches].sort((a, b) => b.fit - a.fit);
  const background: [string, ProfileItem[]][] = [
    [c("经历", "Experience"), profile.experience],
    [c("教育", "Education"), profile.education],
    [c("科研", "Research"), profile.research],
  ];

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-zinc-500">@{profile.login} · {tx(profile.direction)} · {c(`${profile.years} 年经验`, `${profile.years} yrs experience`)}</p>
            <h2 className="mt-1 text-xl font-black text-zinc-100">{profile.name}</h2>
            <p className="mt-1 text-sm text-zinc-300">{tx(profile.headline)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButton} onClick={onReset}><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{c("修改资料", "Edit inputs")}</button>
            <button type="button" className={secondaryButton} onClick={onReset}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{c("删除画像", "Delete profile")}</button>
          </div>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-zinc-300">{tx(report.summary)}</p>
        <ul className="mt-4 flex flex-wrap gap-2">
          {report.strengths.map((s) => <li key={s.en}><Chip tone="good">{tx(s)}</Chip></li>)}
        </ul>
        <label className="mt-5 flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <input type="checkbox" className="mt-1" checked={optedIn} onChange={(e) => setOptedIn(e.target.checked)} />
          <span>
            <span className="block text-sm font-medium text-zinc-100">{c("开放机会：允许企业在人才池中匹配到我", "Open to opportunities: let companies match me in the talent pool")}</span>
            <span className="mt-0.5 block text-xs text-zinc-500">{c("企业只能看到画像与匹配度，看不到原始简历。可随时关闭。", "Companies see your profile and match score, never your raw résumé. Turn off any time.")}</span>
          </span>
        </label>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={c("GitHub 证据强度", "GitHub evidence")} aside={<SourceBadge source="verified" copy={copy} />}>
          <ul className="space-y-3">
            {DIMENSIONS.map((key) => (
              <li key={key}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-zinc-400">{c(...DIMENSION_LABELS[key])}</span>
                  <span className="tabular-nums text-zinc-300">{profile.dimensions[key]} / {SUBSCORE_MAX[key]}</span>
                </div>
                <Bar pct={profile.dimensions[key] / SUBSCORE_MAX[key]} />
              </li>
            ))}
          </ul>
        </Card>

        <Card title={c("背景", "Background")}>
          <div className="space-y-4">
            {background.map(([label, items]) => (
              <div key={label}>
                <h3 className="mb-2 text-xs font-semibold text-zinc-500">{label}</h3>
                {items.length === 0 ? (
                  <p className="text-sm text-zinc-500">{c("未在资料中发现", "Nothing found in your material")}</p>
                ) : (
                  <ul className="space-y-2">
                    {items.map((item) => (
                      <li key={item.title.en} className="flex items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block text-sm text-zinc-200">{tx(item.title)}</span>
                          <span className="block text-xs text-zinc-500">{tx(item.detail)}</span>
                        </span>
                        <SourceBadge source={item.source} copy={copy} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <p className="border-t border-white/5 pt-3 text-xs text-zinc-500">
              {c("期望：", "Preferences: ")}{tx(profile.preferences.location)} · {tx(profile.preferences.employment)}{profile.preferences.remote ? c(" · 可远程", " · Remote OK") : ""}
            </p>
          </div>
        </Card>
      </div>

      <Card title={c("技能", "Skills")}>
        <ul className="grid gap-3 sm:grid-cols-2">
          {profile.skills.map((skill) => (
            <li key={skill.id} className="rounded-xl border border-white/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-zinc-100">{skill.label}</span>
                <SourceBadge source={skill.source} copy={copy} />
              </div>
              <div className="mt-2 flex gap-1" aria-label={c(`熟练度 ${skill.level} / 4`, `Level ${skill.level} of 4`)}>
                {[1, 2, 3, 4].map((n) => <span key={n} className={`h-1.5 flex-1 rounded-full ${n <= skill.level ? "bg-emerald-400" : "bg-white/10"}`} />)}
              </div>
              <p className="mt-2 text-xs text-zinc-500">{tx(skill.evidence)}</p>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={c("推荐岗位", "Matching roles")} aside={<Link href="/jobs" prefetch={false} className="text-xs text-zinc-400 hover:text-zinc-200">{c("全部岗位", "All roles")} →</Link>}>
        <ul className="space-y-4">
          {matches.map((m) => (
            <li key={m.jobId} className="rounded-xl border border-white/10 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs text-zinc-500">{m.company} · {tx(m.location)}</p>
                  <h3 className="mt-0.5 font-semibold text-zinc-100">{tx(m.title)}</h3>
                  <p className="mt-1 text-sm text-zinc-400">{tx(m.reason)}</p>
                </div>
                <FitScore fit={m.fit} label={reachLabel(m.reach, c)} />
              </div>
              <div className="mt-4"><Breakdown breakdown={m.breakdown} copy={copy} /></div>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {m.matched.map((s) => <Chip key={s} tone="good">{s}</Chip>)}
                {m.gaps.map((g) => <Chip key={g.label.en} tone="gap">{tx(g.label)} · {costLabel(g.cost, c)}</Chip>)}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={c("成长路线", "Growth plan")}>
        <ol className="space-y-4">
          {report.growth.map((g) => {
            const Icon = GROWTH_ICONS[g.kind];
            return (
              <li key={g.title.en} className="flex gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-300">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-semibold text-zinc-100">{tx(g.title)}</h3>
                    <span className="text-xs text-zinc-500">{tx(g.horizon)}</span>
                  </div>
                  <p className="mt-1 text-sm text-zinc-400">{tx(g.detail)}</p>
                  {g.repo && (
                    <Link
                      href={`/developers/repo/${g.repo.fullName.split("/").map(encodeURIComponent).join("/")}`}
                      prefetch={false}
                      className="mt-2 inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5"
                    >
                      <Code2 className="h-3.5 w-3.5" aria-hidden="true" />{g.repo.fullName}
                      <span className="inline-flex items-center gap-0.5 text-zinc-500"><Star className="h-3 w-3" aria-hidden="true" />{(g.repo.stars / 1000).toFixed(0)}k</span>
                      <span className="text-zinc-500">{g.repo.language}</span>
                      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {g.closes.map((gap) => <Chip key={gap.en}>{c("补齐：", "Closes: ")}{tx(gap)}</Chip>)}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      <p className="text-xs text-zinc-500">
        {c(`匹配度由确定性规则计算（v${report.matchVersion}），AI 只负责抽取资料与撰写建议。推荐项目来自 ghfind 项目库。`, `Match scores come from deterministic rules (v${report.matchVersion}); AI only extracts your material and writes the advice. Recommended projects come from the ghfind project feed.`)}
      </p>
    </div>
  );
}
