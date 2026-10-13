# Cloudflare cost monitor

An independent Worker polls closed five-minute analytics windows with ten minutes
of ingestion allowance. A bounded SQLite Durable Object owns observations,
incidents and per-recipient delivery receipts; business requests do not pass
through it. Aggregation delay does not guarantee final or complete analytics.

## Read an alert

The subject states the main problem. Metrics are grouped by affected resource,
with the next action, observed value, trigger and time window. HTML expands at
most three resources and three metrics per resource, then lists up to five other
resources and a remaining count. Plain text preserves every selected metric's
evidence once. Both use UTC+8 and support rolling upgrades from old text notices.
HTML supports light/dark email clients, narrow screens and keyboard focus.

- **Functional/runtime incident:** an observed operation failed or crossed a
  runtime threshold. Check the feature, recent deployment and upstream logs.
- **Usage/reported-cost incident:** valid data crossed consumption or efficiency
  thresholds. Check the resource and billing dashboard. Analytics estimates are
  not an invoice.
- **Collection gap:** some data is unavailable. Check the named source, permissions,
  limits or delay. Missing telemetry does not prove overspending or a user outage.

Only fixed sanitized failure classifications leave collectors. Raw upstream
errors, SQL, parameters, user IDs, request bodies and keys are not retained or
included in mail. Recipient addresses remain private configuration.

## Notification timing

| Event | First notification | Unchanged reminder |
| --- | --- | --- |
| Severe key-feature failure, account consumption or reported daily cost | Next evaluation, bypassing digest wait | 6 hours for fast telemetry; 24 hours for reported daily cost |
| Other usage/runtime/efficiency issue | Next hourly digest after confirmation | 6 hours |
| Collection gap | At least 30 minutes and three distinct failed cycles, then next hourly digest | 12 hours |
| Monitor stopped or email sending failed | External watchdog's next hourly check | 12 hours per recipient |

Escalation can notify sooner. Ordinary incidents that recover before their digest
are withdrawn. Recovery needs two valid normal observations; missing data or no
traffic is not recovery. Key-feature and collection recovery are silent. Other
previously delivered incidents can appear as recovered in the next digest. Stale
open/reminder messages are removed on confirmed recovery, including partial sends.

A collection gap is one persisted incident even if its reason changes. A complete
observation withdraws its queued message; two distinct complete windows close it.
Partial-recipient receipts survive a single good observation followed by failure.
Old stateless critical collection notices are discarded during upgrade.

Each recipient receives at most one aggregate message per evaluation. Accepted
recipients are not resent on ordinary retries; failures remain queued. Sending is
limited to 8 attempts/hour and 120/day. Provider acceptance is not final delivery.
Check Email Service delivery logs. A crash after provider acceptance but before
recording its receipt can still duplicate a message.

## Sliding windows and cost meaning

Account consumption retains twelve complete five-minute buckets at most:

- Critical: both the latest **5-minute** and **15-minute** hourly rates exceed
  the critical threshold.
- Warning: both the **15-minute** and **1-hour** rates exceed the warning threshold.
- Extreme spend: a single five-minute bucket already consumes the critical hourly
  amount, so it alerts immediately without waiting for longer history.
- Missing buckets stay unknown, never zero. Replays do not add consumption or
  train baselines twice. High current use with incomplete history cannot falsely
  close a consumption incident.

Default policies are $0.50/hour warning, $2/hour critical and $10/reported day
warning ($30/reported day critical). These are operator choices, not universal
SaaS limits; review them against the account's normal traffic and budget.

Fast estimates use published overage unit prices **before included allowances**,
not the amount actually charged. They cover D1 rows, Workers requests/CPU, R2
operations/storage, KV operations, DO SQL rows and Queue operations. External LLM
fees, DO compute, KV/D1 storage and products without adapters are outside this
fast total. R2 storage uses the last hour's peak and a 30-day conversion. A known
storage gauge missing from the current snapshot makes account cost coverage
incomplete: old charges are neither copied forward as current data nor assumed
zero. Deleted buckets can remain conservatively unknown until a new snapshot or
the remembered gauge's original seven-day TTL expires. Other resource alerts
continue while account cost coverage is incomplete.

Closed reported daily billable usage is reconciled every six hours across all
products. Failed requests retry at most hourly and remain a collection gap until
success; a skipped billing tick cannot erase that failure. Reported billing can
be delayed or adjusted and stays separate from fast estimates.

Ordinary warnings need two consecutive valid windows. Healthy EWMA baselines
need twelve observations and minimum activity; suspicious data does not train
them. Relative 3x/10x anomalies also require $0.05/$0.50 per-hour estimated use,
including SQL fingerprints. SQL diagnostics require two windows even for absolute
critical thresholds. Worker errors need at least three errors and twenty calls;
separate key-feature signals retain immediate failure detection at low traffic.
DO/KV/R2/Queues ratios use account-wide Worker calls as a reference denominator,
not the actual number of operations on the individual resource.

## Collection bounds and failure isolation

Each collection makes eight bounded GraphQL calls, plus billing when due. API
responses are capped at 2 MiB. Unknown billable operations, unavailable core
sources and truncated core results are explicit gaps, never zero usage.

SQL fingerprints are optional diagnostics, not extra billable consumption:

- At most 48 diagnostic points, leaving 16 point slots and 8 KiB for later
  business/probe/billing additions within the 192-point/48-KiB frame limit.
- At most 96 diagnostic states and 24 diagnostic notices within overall limits
  of 256 metrics and 64 notices. Old fingerprint-heavy states are compacted;
  core observations and notices take priority.
- Limited/failed SQL breakdowns appear in `Frame.diagnostics`, not as failed core
  collection. Missing fingerprints in incomplete breakdowns cannot prove recovery.

Evaluation uses a candidate state. Late frame/cardinality/storage failures do not
partially advance baselines, successful-collection times or billing freshness.
Window and candidate-state writes share a SQLite transaction. Accepted frames
leave 16 KiB for health and delivery state; sending preflights its recipient
receipt with 8 KiB remaining, so capacity exhaustion pauses mail before sending
and retains the outbox instead of losing an accepted receipt.
Expected upstream gaps are persisted normally, without throwing an uncaught
Worker exception that this monitor would ingest as another runtime incident.

One aggregate JSON row is retained per window: 24-hour TTL, 288 rows, at most
48 KiB per row. State has a seven-day TTL and 192-KiB cap. The outbox expires after
seven days; the last twelve delivery receipts expire after 24 hours. Indexed
cleanup runs per collection and through a daily alarm. A persisted lease prevents
concurrent polls.

## Key-feature checks

The API Tail Worker saves five-minute counts for README large/mini cards, badges,
homepage analysis and roast generation. It recognizes failed `roast.summary`
results even after HTTP 200. User-supplied model configuration errors, ordinary
4xx responses and client disconnects are excluded. Only fixed feature names,
times and counts are retained; Tail can retry, so counts are observations, not
financial accounting. No traffic does not establish recovery.

Each cycle also GET-probes the homepage and torvalds large/mini cards for HTTP
status and Content-Type. It does not start GitHub analysis or paid LLM generation.
Probe failures need two windows. Passing probes do not prove correctness for every
user's content. Tail arrives after streams finish; ingestion allowance also adds
to detection latency.

## Health and external watchdog

Authenticated `GET /health` version 2 separates `heartbeatHealthy`,
`collectionHealthy` and `deliveryHealthy`, with last attempted/completed ticks,
billing attempt/success and sanitized incident metadata. Recipient receipts with
addresses are omitted. Legacy `healthy` remains the combined status.
`POST /run` performs a real collection and can send due mail; it is not read-only.

The GitHub Actions watchdog checks hourly. It alerts only for a missing/stale
heartbeat or explicit delivery failure; the Worker owns upstream collection gaps.
For legacy responses it uses `lastAttempt`, falling back to `lastSuccess` only
when the former field is absent.

A serialized job restores/saves bounded state through Actions cache, including
after partial send failure. State contains incident times and keyed HMACs of
monitor/recipient identities, not raw addresses, URLs or credentials. File writes
are atomic with mode 0600. Each recipient is retried independently; recovery is
silent. Cache eviction or administrator-key rotation can trigger a fresh notice.
Actions scheduling/cache retention are best-effort. The sending path still uses
Cloudflare Email Service, so a platform-wide outage requires another provider for
independent delivery.

## Private configuration and rollout

Use Wrangler secret input or a private bulk file for `CF_MONITOR_API_TOKEN`,
`MONITOR_ADMIN_TOKEN` and `ALERT_RECIPIENTS`. The recipient JSON list supports empty
placeholders, for example `["owner@example.org", ""]`, with up to twenty addresses.
Never commit real recipients, credentials or private incident evidence.

The dedicated token is account-restricted: Account Analytics Read, Billing Read
and Email Sending Edit for the external watchdog. Native Worker mail uses the
`EMAIL` binding and an already-onboarded sender domain.

GitHub uses `CF_MONITOR_API_TOKEN`, `COST_MONITOR_ADMIN_TOKEN` and
`COST_MONITOR_RECIPIENTS` secrets plus the `COST_MONITOR_URL` variable. The workflow
provides `WATCHDOG_STATE_FILE`. Production requires successful main CI and source
SHA checks. Deploy the Tail consumer before its API producer. Production has no
synthetic routes or captured-mail mode.

## Validation

Run `pnpm --filter @ghfind/cost-monitor typecheck`,
`pnpm exec vitest run apps/cost-monitor/src/__tests__`,
`node --test scripts/cost-monitor-watchdog.test.mjs` and
`node scripts/cost-monitor-e2e.mjs`.

E2E uses isolated real workerd/SQLite with captured mail. It checks hourly batching,
urgent bypass, partial-recipient retries, twelve-hour collection reminders,
recovery, storage limits, TTL cleanup and scheduled gaps. No live recipient is
used locally. A remote `COST_MONITOR_URL` changes the suite into an explicit
rehearsal that can send mail: only use an isolated E2E Worker with approved private
recipients, never production. Evidence belongs in private git-ignored files.

Design references: [Alertmanager grouping and inhibition](https://prometheus.io/docs/alerting/latest/alertmanager/),
[Google SRE multiwindow alerting](https://sre.google/workbook/alerting-on-slos/),
[Cloudflare Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/),
[D1 metric definitions](https://developers.cloudflare.com/d1/observability/metrics-analytics/).
The windowing technique informs this policy; USD thresholds do not implement
Google's SLO error-budget formula.
