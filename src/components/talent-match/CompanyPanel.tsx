"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ClipboardPaste, RefreshCw, Search, ShieldCheck, Users } from "lucide-react";
import { MOCK_COMPANY_REPORT, SAMPLE_JD } from "@/lib/talent-match/mock";
import { COMPANY_STAGES, type CandidateMatch, type CompanyReport } from "@/lib/talent-match/types";
import { Breakdown, Card, Chip, FitScore, StageProgress, fieldClass, primaryButton, secondaryButton, type Copy } from "./parts";

const STAGE_LABELS: Record<(typeof COMPANY_STAGES)[number], [string, string]> = {
  extract: ["解析 JD，抽取岗位要求", "Parsing the JD into requirements"],
  recall: ["在开放机会的人才池中召回候选人", "Recalling candidates from the opt-in pool"],
  score: ["逐项计算匹配度", "Scoring each requirement"],
};

const STAGE_MS = 700;
const MIN_JD_CHARS = 80;

export function CompanyPanel({ copy, login, onSignIn }: { copy: Copy; login: string | null; onSignIn: () => void }) {
  const { c } = copy;
  const [jd, setJd] = useState("");
  const [stage, setStage] = useState<number | null>(null);
  const [report, setReport] = useState<CompanyReport | null>(null);

  useEffect(() => {
    if (stage === null) return;
    const timer = setTimeout(() => {
      if (stage + 1 < COMPANY_STAGES.length) {
        setStage(stage + 1);
      } else {
        setStage(null);
        setReport(MOCK_COMPANY_REPORT);
      }
    }, STAGE_MS);
    return () => clearTimeout(timer);
  }, [stage]);

  if (stage !== null) {
    return (
      <Card title={c("正在匹配", "Matching")}>
        <StageProgress stages={COMPANY_STAGES.map((s) => c(...STAGE_LABELS[s]))} current={stage} />
      </Card>
    );
  }

  if (report) return <CompanyReportView report={report} copy={copy} onReset={() => setReport(null)} />;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
      <Card
        title={c("岗位描述（JD）", "Job description")}
        aside={<button type="button" className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200" onClick={() => setJd(SAMPLE_JD)}><ClipboardPaste className="h-3.5 w-3.5" aria-hidden="true" />{c("填入示例 JD", "Use a sample JD")}</button>}
      >
        <textarea
          className={`${fieldClass} min-h-72 resize-y font-mono text-xs leading-relaxed`}
          placeholder={c("粘贴岗位职责与任职要求……", "Paste the responsibilities and requirements…")}
          value={jd}
          onChange={(e) => setJd(e.target.value)}
        />
        <p className="mt-2 text-xs text-zinc-500">{c(`${jd.trim().length} 字符，至少 ${MIN_JD_CHARS}`, `${jd.trim().length} characters, at least ${MIN_JD_CHARS}`)}</p>
      </Card>

      <Card title={c("如何匹配", "How matching works")}>
        <ul className="space-y-2.5 text-sm text-zinc-300">
          <li className="flex gap-2"><Users className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />{c("只搜索主动开启「开放机会」的人才。", "Only talents who turned on “open to opportunities” are searched.")}</li>
          <li className="flex gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />{c("区分 GitHub 已验证能力与简历自述。", "GitHub-verified skills are told apart from claims.")}</li>
          <li className="flex gap-2"><Search className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />{c("匹配度按必备 / 加分 / 硬条件拆解。", "Scores break down into must-have, nice-to-have and conditions.")}</li>
        </ul>
        <div className="mt-5">
          {login ? (
            <button type="button" className={`${primaryButton} w-full`} disabled={jd.trim().length < MIN_JD_CHARS} onClick={() => setStage(0)}>
              <Search className="h-4 w-4" aria-hidden="true" />{c("匹配候选人", "Find candidates")}
            </button>
          ) : (
            <button type="button" className={`${primaryButton} w-full`} onClick={onSignIn}>{c("登录 GitHub 后使用", "Sign in with GitHub to use")}</button>
          )}
          <button type="button" className={`${secondaryButton} mt-2 w-full`} onClick={() => setReport(MOCK_COMPANY_REPORT)}>{c("查看示例结果", "View sample results")}</button>
          <p className="mt-3 text-xs text-zinc-500">{c("Beta：首批向赞助企业开放。", "Beta: opening to sponsor companies first.")}</p>
        </div>
      </Card>
    </div>
  );
}

function CompanyReportView({ report, copy, onReset }: { report: CompanyReport; copy: Copy; onReset: () => void }) {
  const { c, tx } = copy;
  const req = report.requirement;
  return (
    <div className="space-y-5">
      <Card title={c("岗位要求（AI 解析）", "Requirements (parsed by AI)")} aside={<button type="button" className={secondaryButton} onClick={onReset}><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{c("换一个 JD", "New JD")}</button>}>
        <h2 className="text-lg font-black text-zinc-100">{tx(req.title)}</h2>
        <p className="mt-1 text-xs text-zinc-500">{tx(req.direction)} · {tx(req.years)} · {tx(req.location)}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold text-zinc-500">{c("必备", "Must-have")}</h3>
            <div className="flex flex-wrap gap-1.5">{req.mustHave.map((s) => <Chip key={s.label}>{s.label} · L{s.level}</Chip>)}</div>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold text-zinc-500">{c("加分", "Nice-to-have")}</h3>
            <div className="flex flex-wrap gap-1.5">{req.niceToHave.map((s) => <Chip key={s.label}>{s.label}</Chip>)}</div>
          </div>
        </div>
        <p className="mt-4 text-xs text-zinc-500">{c("硬条件：", "Conditions: ")}{req.conditions.map(tx).join("；")}</p>
      </Card>

      <Card title={c(`匹配候选人 · 共搜索 ${report.poolSize.toLocaleString()} 位开放机会的人才`, `Candidates · searched ${report.poolSize.toLocaleString()} opt-in talents`)}>
        <ul className="space-y-4">
          {report.candidates.map((cand) => <CandidateRow key={cand.login} cand={cand} copy={copy} />)}
        </ul>
      </Card>
    </div>
  );
}

function CandidateRow({ cand, copy }: { cand: CandidateMatch; copy: Copy }) {
  const { c, tx } = copy;
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-xl border border-white/10 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-zinc-500">@{cand.login} · {tx(cand.location)}</p>
          <h3 className="mt-0.5 font-semibold text-zinc-100">{cand.name}</h3>
          <p className="mt-1 text-sm text-zinc-400">{tx(cand.headline)}</p>
        </div>
        <FitScore fit={cand.fit} label={c(`${Math.round(cand.verifiedShare * 100)}% 已验证`, `${Math.round(cand.verifiedShare * 100)}% verified`)} />
      </div>
      <div className="mt-4"><Breakdown breakdown={cand.breakdown} copy={copy} /></div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {cand.matched.map((s) => <Chip key={s} tone="good">{s}</Chip>)}
        {cand.missing.map((s) => <Chip key={s} tone="gap">{c("缺：", "Missing: ")}{s}</Chip>)}
      </div>
      <button type="button" className="mt-3 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200" aria-expanded={open} onClick={() => setOpen(!open)}>
        {c("为什么匹配？", "Why this match?")}<ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && <p className="mt-2 rounded-lg bg-white/[0.02] p-3 text-sm text-zinc-300">{tx(cand.explain)}</p>}
    </li>
  );
}
