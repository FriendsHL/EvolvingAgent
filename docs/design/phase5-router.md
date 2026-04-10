# Phase 5 — Router + Role-shaped Sub-Agents (Direction C)

Status: **Design locked, not yet implemented.** Implementation happens on a
side branch (`phase5-router`) **after** the current E2E testing round lands.
This document is the canonical integrated spec — it supersedes the three
intermediate artifacts produced by the Designer / Researcher / Critic agents.

## 1. Why we're doing this

The current single-agent `planner → executor → reflector` loop has three
structural problems the user cited in real E2E testing:

1. **Misclassification is unrecoverable.** `planner.ts:122-128` catches
   JSON parse failures by returning an empty plan, which the conversational
   branch then hallucinates over (the "what time is it" → fabricated time
   failure).
2. **Adding behavior is whack-a-mole.** Every new failure becomes another
   if-rule in the planner system prompt. Prompts inflate; rules conflict;
   the LLM gets confused by the growing list.
3. **The plan is frozen JSON.** When execution discovers something new
   (e.g. `browser.goto` returns 403 but the body is readable), there's no
   way to adapt mid-plan — Reflector must re-plan from scratch.

The user explicitly rejected "tool-bucket" sub-agents (e.g. a "web-fetch
agent" / "system agent"). Sub-agents must be shaped by **role / identity**
(调研 / 代码 / 分析 …), not by the tools they wrap.

## 2. Design decisions (locked)

These are the outcomes of the Designer / Researcher / Critic three-agent
review. Most contradictions resolved in Researcher's favour, based on how
Claude Code actually ships in production.

### 2.1 Router = a `delegate` tool, not a separate class

**Decision**: Routing is a new `delegate` tool added to the main agent's
tool catalog. Its JSON schema has `subagent_type` as an **enum** of loaded
sub-agent names. The LLM picks via function calling; there is no separate
Router LLM call. See `claude-code-source/src/tools/AgentTool/prompt.ts:66-212`
for the production pattern.

**Why not a separate RouterAgent class**: it costs +1 LLM round-trip per
turn (real money on bailian-coding, which has no prompt cache), duplicates
JSON-parse failure modes, and provides no architectural benefit over a
well-described tool.

**Open contingency**: if bailian-coding's tool-calling API does not support
enum-typed parameters, we fall back to structured JSON output from a mode-
swapped planner prompt. Verify by reading
`packages/core/src/llm/provider.ts` in the first hour of implementation.

### 2.2 Keep `planner → executor → reflector`; swap the planner prompt

**Decision**: No `RouterAgent` class, no `SubAgentRuntime` class. Instead,
add `mode: 'router' | 'solo'` to `Agent` construction (reads env flag
`EA_ROUTER`). In router mode, the planner's system prompt is replaced with
a router prompt whose only allowed outputs are:

- `{ mode: 'direct', text }` — for greetings, stable-knowledge Q&A, formatting
- `{ mode: 'delegate', target: 'research', task }` — for anything needing fresh facts

**Also required**: invert `planner.ts:122-128`'s fallback. On JSON parse
failure, return `delegate research` instead of empty steps. This is the
concrete fix for the "what time is it" hallucination class.

**Why not tear out the loop**: Researcher's Pattern C — Claude Code's
coordinator mode is literally a system-prompt swap gated by
`CLAUDE_CODE_COORDINATOR_MODE` (`src/coordinator/coordinatorMode.ts:36-41`).
Anthropic's own production CLI runs single-agent by default; multi-agent is
opt-in. Reuses ~90% of the existing executor.

### 2.3 Sub-agent definitions: frontmatter Markdown, in `packages/core/src/sub-agents/builtin/`

**Decision**: Ship sub-agent definitions as Markdown with YAML frontmatter,
mirroring Claude Code's format (`loadAgentsDir.ts:296-393`):

```markdown
---
name: research
description: Pick me for anything needing fresh facts from the web, page summarization, or cross-source verification.
tools: [browser, http]
disallowedTools: []
skills: [web-search, summarize-url, data-extract]
model: inherit
memory: none
max_iterations: 8
---

# Identity

You are a research specialist. You are rigorous, skeptical, and...
```

- **Built-ins** live at `packages/core/src/sub-agents/builtin/*.md`, shipped
  with the code, loaded at startup.
- **User overrides** live at `data/sub-agents/*.md`, loaded after builtins
  and overriding by name. Mirrors the `PromptRegistry` defaults+active
  pattern already used in Phase 4 C.
- The identity prompt body is registered as a new `PromptId`
  (`subagent:<name>`) in `PromptRegistry`, so Phase 4 C's prompt optimizer
  can self-tune sub-agent personalities the same way it tunes the planner.

**Frontmatter fields (v1)**:

| Field             | Type                              | Default   | Purpose                                                                   |
| ----------------- | --------------------------------- | --------- | ------------------------------------------------------------------------- |
| `name`            | string                            | required  | Unique id, matches router `subagent_type` enum value                      |
| `description`     | string                            | required  | The `whenToPickMe` hint injected into the router's `delegate` tool schema |
| `tools`           | string[]                          | `[]`      | Allowlist of low-level tools                                              |
| `disallowedTools` | string[]                          | `[]`      | Denylist overrides allowlist (e.g. `code` disallows `rm -rf`)             |
| `skills`          | string[]                          | `[]`      | Allowlist of skills                                                       |
| `model`           | string                            | `inherit` | Reserved for Phase 6 (per-agent model override)                           |
| `memory`          | `'none' \| 'private' \| 'shared'` | `none`    | Default is none per CC Pattern E                                          |
| `max_iterations`  | number                            | `8`       | Cap on ReAct loop iterations                                              |

Critical: `memory: none` is the **default**. Don't build the six-directory
namespace tree the Designer proposed — there's zero evidence EA needs
per-role memory partitioning yet.

### 2.4 Sub-agent internal loop: flat ReAct, not nested planner

**Decision**: Sub-agents run a flat function-calling / ReAct loop, not a
nested `planner → executor → reflector` mini-version of the top level.
Claude Code's entire `query()` loop
(`claude-code-source/src/query.ts:1-1729`) is flat; nobody nests planners.

**Implementation**: the existing executor in `packages/core/src/agent.ts`
gets a new code path where instead of parsing a JSON plan up front, it
calls the LLM in a loop: LLM call → tool call → observation → LLM call →
… → final text. Terminates when the LLM emits a no-tool-call message or
`max_iterations` hits.

### 2.5 Tree-shaped, in-process, synchronous (v1)

- **No handoff between sub-agents.** Research cannot directly hand material
  to Analysis. If a turn needs both, the user's second turn re-invokes the
  router which then picks Analysis. Research → Analysis DAG is lifted in
  v1.1 after tree-shape is solid.
- **No persistent sub-agent registry.** Just an in-memory `Map<name, def>`.
  No orphan recovery, no lifecycle events, no archive — all the heavy
  Claude-Code machinery in `subagent-registry.ts:831 lines` is overkill for
  a single-user in-process agent.
- **No background tasks.** Always `await` the sub-agent; UI sees a single
  continuous stream.

### 2.6 Port Claude Code's "never delegate understanding" prompt language

**Decision**: The router system prompt copies, nearly verbatim, CC's
coordinator-mode rules from `coordinatorMode.ts:255-268` + `prompt.ts:99-113`:

- Synthesize before re-delegating.
- The delegate task spec must contain file paths and line numbers.
- Never write "based on your findings, fix it" — that shifts understanding
  to the sub-agent.
- Sub-agent results arrive as `<task-notification>`-style synthetic user
  messages; never fabricate them.

Researcher called this the single highest-leverage prompt-engineering
finding in both reference codebases. It's the only reliable mitigation for
the rubber-stamping failure mode that kills naive multi-agent systems.

## 3. v1 scope — the minimum useful slice

Built on a side branch `phase5-router` **after E2E round 2 completes on main**.

### 3.0 S0 — Memory scoring warm-up (lands before any router code)

**Why it lives here**: Phase 5's research sub-agent will hit the retriever
an order of magnitude more than the current single-agent path. If we ship
router+sub-agent on top of EA's current 3-dimension health scoring, we get
a research agent whose memory surface is a saturated counter
(`Math.min(1.0, referencedCount / 10)` in `experience-store.ts:252` — a
memory used 1000 times and one used 10 times look identical). The scoring
upgrade is both a prerequisite for credible sub-agent behavior and a
low-risk internal change that's easy to land first.

**Source of the design**: adapted from openclaw's six-signal dreaming
consolidation weighting (`extensions/memory-core/src/dreaming.ts` in
`/Users/huanglin12/myspace/openclaw`), minus the stuff we don't need
(cron/phase machine/diary narrative — those are Phase 6).

**What exists today** (two separate scoring layers in EA):

- Admission scoring, 5-D, at experience creation — `packages/core/src/memory/admission.ts`
  - `novelty / lessonValue / reusability / userSignal / complexity`
  - This layer stays untouched in S0.
- Health scoring, 3-D, at retrieval/eviction — `packages/core/src/memory/experience-store.ts:243 computeHealthScore`
  - `recency (0.30) + frequency (0.30) + quality (0.40)`
  - This layer gets rewritten in S0.

**Four dimensions that are currently missing** and that S0 adds:

1. **Relevance-weighted retrieval** (target weight ~0.30). Today
   `referencedCount++` fires on every hit regardless of similarity — a
   0.99 precision match and a 0.51 border-line scrape score identically.
   Add `health.totalRelevance` (running sum of similarity scores); derive
   `avgRelevance = totalRelevance / referencedCount`.

2. **Query diversity** (target ~0.15). An experience hit by one repeated
   query vs by 50 distinct queries carries very different signal. Add
   `health.distinctQueries` (count) and/or cluster recent query vectors.

3. **Multi-day consolidation** (target ~0.10). "Used 20 times today" is
   noise; "used 2 times a day for 10 days" is a stable pattern. Compute
   `distinctDays` from the new retrieval log (see below).

4. **Conceptual richness** (target ~0.06). Information density / embedding
   L2 norm / concept-tag count. Cheap to compute at admission time; acts
   as a small tiebreaker.

**Plus one bug to fix while we're here**: the frequency term is currently
saturated at `referencedCount / 10`. Replace with log-scale:
`log(1 + count) / log(1 + maxCountAmongActive)`, or quantile bucketing.
This single change meaningfully reshapes eviction order for any pool
with a long tail.

**Required infrastructure**:

- `packages/core/src/memory/recall-log.ts` (new, ~100 lines). Appends
  `{experienceId, query, similarity, timestamp, sessionId}` to
  `data/memory/recall-log/YYYY-MM-DD.jsonl` on every retrieval hit. Adds
  a `readRecent(days)` helper for downstream scoring. JSONL format matches
  the existing `metrics/calls/` convention so operational tooling carries
  over.

- `packages/core/src/memory/retriever.ts` (modified, ~10 lines). On each
  successful retrieval, call `recallLog.append(...)` before returning. No
  behavior change to the retrieval itself.

- `packages/core/src/types.ts` (modified, ~8 lines). Extend
  `ExperienceHealth` with optional `totalRelevance?: number`,
  `distinctQueries?: number`, `distinctDays?: number`,
  `conceptualRichness?: number`. Optional to avoid schema migration on
  existing experiences — undefined is treated as 0 at read time.

- `packages/core/src/memory/experience-store.ts` (modified, ~80 lines).
  Rewrite `computeHealthScore` as a six-signal weighted sum. Periodic
  pool-wide recomputation walks the recall log to refresh
  `distinctQueries` / `distinctDays` / `totalRelevance` — runs on the
  same cadence as the existing stale→archive eviction sweep so no new
  scheduler is needed.

**Scoring formula** (starting point, tunable in S0.1):

```
health = 0.24 * logScaleFrequency
       + 0.30 * avgRelevance
       + 0.15 * normalizedDiversity
       + 0.15 * recencyDecay           // existing 14-day half-life, kept
       + 0.10 * normalizedDistinctDays
       + 0.06 * conceptualRichness
```

Weights copy openclaw's defaults verbatim; they'll need calibration once
we have real retrieval traces.

**S0 acceptance criteria**:

1. All existing tests pass unchanged (the scoring rewrite is internal).
2. A new test covers recall-log append/read + six-signal computation on
   a small fixture set.
3. `computeHealthScore` returns a value in `[0, 1]` for every experience
   in the test fixtures, including ones with `undefined` new fields.
4. Feed a synthetic pool with three profiles — "hot hit 100×", "single
   query 50×", "stable 2×/day × 10d" — and verify the stable pattern
   ranks highest under the new formula (current formula ranks them all
   ≈ equal due to frequency saturation).

**S0 is NOT**: dreaming cron, daily-note side channel, diary narrative,
DREAMS.md output, phase machine, or any LLM call. Those are Phase 6 and
deliberately stay out — S0 is a pure scoring upgrade that lands before
any router code, ~250 lines total across 4 files.

### 3.0.5 Pre-S1 investigation results (locked 2026-04-09)

Two questions from §7 ("Outstanding questions before code starts") were
investigated before any router code went in. Their answers materially
simplify the v1 implementation — the spec section below ( §3.1+ ) is
revised in light of them. Read this subsection first.

#### Question 1 — does bailian-coding honor enum-typed tool args?

**Answer: YES, strictly.** Verdict from `packages/core/src/sub-agents/probe.ts`
ran against the live env (`EVOLVING_AGENT_PROVIDER=bailian-coding`,
`planner=qwen3-coder-plus`):

```
Verdict: function-calling-strict
Tool call returned subagent_type="research" — strictly in [research, code, analysis]
```

The probe registers a `delegate` tool with `subagent_type: z.enum([...])`,
asks the planner LLM to pick a sub-agent for a sample task, and verifies
the returned `toolCalls[0].args.subagent_type` is in the enum. The
provider passes the schema, and the model honors it at the token level.

**Implication for Router design**:

- Router uses **function calling**, not JSON-output mode. No `JSON.parse`,
  no zod parse-failure fallback, no "what if the LLM picks 'researcher'
  instead of 'research'" defensive code. The schema is the contract.
- Router decision shape is the tool call itself:
  ```ts
  delegate({
    subagent_type: 'research' | 'code' | 'analysis',  // enum-constrained
    task: string,                                       // self-contained instruction
    rationale: string,                                  // one-line why
  })
  ```
- No separate `mode: 'direct' | 'delegate'` field needed — direct mode is
  "no tool call, just text." The presence/absence of `toolCalls[0]` IS
  the routing decision.
- The catch-block fallback at `planner.ts:122-128` still needs inverting,
  but the failure mode it inverts is now narrower: "model emitted text
  instead of a tool call AND that text isn't a confident direct answer"
  → still treat as `delegate research`.

The probe + verdict are persisted to `data/phase5-probe.log` so the
result survives across sessions; rerun the probe if the provider or
model changes.

#### Question 2 — can we reuse the existing `multi-agent/` infrastructure?

**Answer: PARTIALLY — reuse `SubAgentManager`, skip `AgentCoordinator` +
`TaskDelegator`.** Key findings from reading `packages/core/src/multi-agent/`
and `packages/core/src/sub-agent/manager.ts`:

**Reuse directly (no changes needed)**:

- `SubAgentManager` (`sub-agent/manager.ts:153`) already provides:
  - `spawn(spec)` with `mode: 'template'` or `mode: 'adhoc'`
  - Full IPC protocol (TaskAssign / TaskResult / TaskProgress / TaskCancel /
    ResourceRequest) over `InProcessTransport`
  - Tool scoping via `sharedTools` whitelist (`manager.ts:133`)
  - Progress event streaming → **directly solves** the "what does the user
    see during sub-agent run" UX gap Critic flagged in §4
  - Per-spawn cancel + cancelAll
  - `resolveTemplate(templateId)` callback that lets us inject our own
    markdown frontmatter loader as the template source

The SubAgentManager is high-quality, well-tested, and almost exactly the
runtime Phase 5 router needs. **Critic's "build a SubAgentRuntime class"
in §3.1 is wrong**: that runtime already exists. The v1 implementation
just calls `subAgentManager.spawn({ mode: 'adhoc', name, systemPrompt,
tools, task })` and awaits the result.

**Do NOT reuse**:

- `AgentCoordinator.routeTask` (`coordinator.ts:235`) — it's a
  keyword-substring matcher against `AgentProfile.capabilities`. That's
  exactly the dumb classifier we want to *replace* with an LLM-driven
  router. Wrong abstraction.
- `TaskDelegator.delegate` (`delegation.ts:43`) — does LLM-driven
  decomposition into subtasks then fan-out. Phase 5 v1 explicitly does
  NOT do decomposition (Critic locked single-target route, no DAG, no
  decomp).
- `MessageBus` — pub/sub layer designed for multi-agent message passing.
  Overkill for in-process single-user EA.

**Production caller audit**: the entire `AgentCoordinator + TaskDelegator
+ MessageBus` system has exactly ONE production caller:
`packages/web/src/server/routes/coordinate.ts:25`, which is the
CoordinatePage backend (the "informational decoration" page). The chat
hot path does not use it. There's also a dormant `Agent.delegate(task,
coordinator)` at `agent.ts:1043-1057` that's wired but never called by
chat. We leave both alone in v1: CoordinatePage keeps working, and the
Phase 5 router goes around them entirely.

#### Revised v1 file list (supersedes §3.1)

The §3.1 file list below is updated based on the two findings above:

| Action | File | Notes |
|---|---|---|
| **NEW** | `packages/core/src/sub-agents/types.ts` | `SubAgentDef` interface. Frontmatter fields per §2.4 |
| **NEW** | `packages/core/src/sub-agents/loader.ts` | Markdown frontmatter parser → `Map<name, SubAgentDef>`. Loads from `builtin/*.md` first, then `data/sub-agents/*.md` overrides |
| **NEW** | `packages/core/src/sub-agents/builtin/research.md` | Research persona identity prompt (canonical location; earlier drafts referenced §6.1 but no such spec section exists — the file itself is the source of truth) |
| **NEW** | `packages/core/src/sub-agents/router-tool.ts` | Builds the `delegate` tool definition with `z.enum(loader.list().map(d => d.name))` for the `subagent_type` parameter — enum is dynamically derived from loaded SubAgentDefs so adding `code.md` later auto-extends the router |
| **NEW** | `packages/core/src/sub-agents/probe.ts` | ✅ **already shipped** as part of the prework. Re-runnable any time |
| **MODIFY** | `packages/core/src/planner/planner.ts` | Add `mode: 'router' \| 'solo'` ctor option (read from env `EA_ROUTER`). In router mode: build the delegate tool, pass `tools` to `llm.generate(...)`, branch on `result.toolCalls.length`. **Invert the catch fallback at `:122-128`**: parse failure → return a `delegate research` plan, not empty steps |
| **MODIFY** | `packages/core/src/agent.ts` | When `processMessage` sees a router-mode plan whose first step is `tool: 'delegate'`, **call `subAgentManager.spawn({ mode: 'adhoc', name: def.name, systemPrompt: def.identityPrompt, tools: def.tools, task: { description: args.task } })` directly**. Wire `handle.onProgress` to the existing event emitter so the chat UI streams sub-agent progress. Await `handle.result()`. Surface `task.outcome === 'failure'` as an explicit error message, not a silent fallback (see acceptance criterion 5 in §3.5) |
| **MODIFY** | `packages/core/src/session/manager.ts` | Instantiate `SubAgentManager` once per session with `dataPath` + the SessionManager's existing `sharedTools`, + a `resolveTemplate` callback that delegates to our markdown loader so `mode: 'template'` calls also work |

**File count**: 5 new + 3 modified = **8 files, ~400-500 LOC** including
the dynamic enum wiring and the SubAgentManager integration. Slightly
larger than Critic's 5-file estimate but ~150 LOC smaller in net effort
because there's no SubAgentRuntime class to invent — we get spawn / IPC /
cancel / progress streaming for free.

#### What this changes about the slice plan

- **S1 (skeleton)** gets to ship a probe + types + loader + one
  `research.md` + the router tool wiring in one commit, because there's
  no runtime to scaffold separately.
- **S2 (router LLM call wired)** is just the planner mode switch + the
  catch-block inversion. ~50 LOC.
- **S3 (research sub-agent end-to-end)** is the agent.ts integration with
  SubAgentManager. The hardest part is making sure progress events flow
  to the chat SSE without re-architecting either side.
- **S4** (code + analysis sub-agents) becomes a copy-paste of `research.md`
  with new bodies. No code changes — just add files and the loader picks
  them up.
- **S5** (memory partitioning) stays as written.
- **S6** (UI) stays as written but is smaller because progress events
  already exist.
- **S7** (cutover) unchanged.

The compressed slice 1 (probe + skeleton + research.md + tool wiring)
is the natural unit for the next 3-agent dev cycle.

### 3.1 Files created

- `packages/core/src/sub-agents/builtin/research.md` — the research sub-agent
  definition. The file itself is the canonical source for the persona prompt
  body; earlier spec drafts referenced a §6.1 section that was never written.
  The prompt was composed in-line during S1 dev by the Dev agent and reviewed
  by Nitpick + Judge, and it's well-scoped and EA-specific enough to serve
  as the ongoing source of truth for the persona.
- `packages/core/src/sub-agents/loader.ts` — ~80 lines. Reads
  `builtin/*.md` + `data/sub-agents/*.md`, parses frontmatter, validates
  schema, registers identity prompts in `PromptRegistry`, returns a
  `Map<name, SubAgentDef>`.
- `packages/core/src/sub-agents/types.ts` — the TypeScript `SubAgentDef`
  interface.

### 3.2 Files edited

- `packages/core/src/planner/planner.ts` — add `ROUTER_MODE` branch. In
  router mode, the planner's only valid outputs are `direct` or
  `delegate(target, task)`. Invert the catch-block fallback at `:122-128`
  to return `delegate research` instead of empty steps.
- `packages/core/src/agent.ts` — on `delegate`, dispatch to
  `runSubAgent(name, task)` which runs the ReAct loop. Gate on
  `EA_ROUTER` env var.
- `packages/core/src/prompts/registry.ts` — no structural change, just
  new `PromptId` values.

### 3.3 Env flag

`EA_ROUTER=on|off` — default `off`. Read once at `Agent` construction.
Only used on the side branch; when the branch merges, the flag is deleted
(we cut over fully).

### 3.4 Explicitly NOT in v1

- Independent `RouterAgent` class
- Independent `SubAgentRuntime` class
- ~~`data/sub-agents/` override directory (builtins only)~~ — actually shipped in
  S1. The loader honors `<dataPath>/sub-agents/*.md` user overrides with the
  same frontmatter format as builtins; missing directory is silent. Harmless
  scope creep, kept because the API shape was symmetric.
- Memory namespacing / per-agent experience slicing (router-mode delegate
  turns currently **bypass** reflector / experience storage / skill-auto-
  create / hook-auto-create — the single-step opaque delegation doesn't fit
  the multi-step JSON plan shape those stages expect. A `hook` trace event
  makes the bypass visible, and **S5 will add a proper sub-agent reflection
  hook** so delegate turns can contribute to experience distillation.)
- Sub-agent-to-sub-agent handoff
- `CoordinatePage` UI changes
- `data/eval/router-cases.jsonl` eval fixture
- `data/config/router.json` kill-switch file
- `code` and `analysis` sub-agents (those are v1.1 and v1.2)
- Phase 4 C prompt optimization of the router prompt itself
- Per-sub-agent model selection (Phase 6)

### 3.5 Acceptance criteria

1. `EA_ROUTER=off`: behavior is byte-identical to `main`. Existing test
   suite (40 files / 424 tests) stays green.
2. `EA_ROUTER=on`, user says "what time is it": delegate → research →
   `shell: date` → correct answer. Logged to
   `data/memory/metrics/router-decisions.jsonl`.
3. `EA_ROUTER=on`, user pastes a URL: delegate → research → `browser.goto`
   + `browser.text` (no selector) → answer with a "Sources" section.
4. `EA_ROUTER=on`, user says "hi": direct mode answers in one line with no
   tool calls and no second LLM round-trip. Greeting p50 latency within
   +20% of flag-off.
5. On sub-agent failure (parse error, tool error, max iterations): the
   user sees an explicit error message. No silent fallback to
   conversational hallucination.

## 4. Risks and mitigations

| Risk                                                           | Likelihood                               | Mitigation                                                                                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bailian-coding tool-calling doesn't support enum params        | Medium                                   | Read `provider.ts` early; fall back to structured-JSON-output router prompt                                                                                               |
| Router direct mode misclassifies                               | High initially                           | Log every decision + rationale to jsonl; manual weekly sampling; no router-cases unit tests (Critic argued those are theater at this scale)                               |
| Research sub-agent blows through tool calls on hard sites      | Medium                                   | `max_iterations` cap = 8; on exhausted, return partial + error                                                                                                            |
| Streaming UX degrades (silent router pause)                    | Medium                                   | Surface router decision as a visible trace event in the chat UI before sub-agent starts; sub-agent tokens stream as today                                                 |
| Phase 4 C self-optimizer gets confused by the new planner mode | Low (user confirmed whole-prompt tuning) | No action required; the optimizer treats the whole planner prompt as a unit                                                                                               |
| Existing `multi-agent/coordinator.ts` is redundant             | Medium                                   | Read `coordinator.ts` + `delegation.ts` before writing any new code; if coordinator.routeTask() can drive the flow, v1 becomes a wiring exercise instead of new subsystem |

## 5. Rollback

The side branch approach eliminates most rollback concerns — if v1 is
worse than expected, the branch simply doesn't merge.

Once merged, the env flag is already gone (deleted at merge time) so
rollback is a git revert of the merge commit. All affected files are
localized to `packages/core/src/{sub-agents,planner,agent,prompts}/`.

## 6. Out-of-scope for Phase 5 entirely

- Per-sub-agent LLM provider/model. Deferred to **Phase 6** (provider routing).
- Async / background / persistent sub-agents. Maybe Phase 7 if users want it.
- Multi-agent DAG handoff. v1.1 after tree is solid.
- Sub-agent marketplace / download. Never in scope.

## 7. Outstanding questions before code starts

Answer these in the first day of the side branch, before writing any
sub-agent code:

1. Does `packages/core/src/llm/provider.ts` pass enum-typed tool params
   through to bailian-coding's API, and does bailian honor them?
2. What does `packages/core/src/multi-agent/coordinator.ts` actually do
   today? Can `routeTask()` drive the new flow with a different
   `AgentProfile` set, making v1 an integration rather than a new subsystem?
3. What's the current p50/p95 latency for a simple chat turn? (User already
   said "use it first, set baselines later" — so this is nice-to-have, not
   blocking.)

## 8. References

- **Claude Code source** (local): `/Users/huanglin12/myspace/claude-code-source`
  - `src/coordinator/coordinatorMode.ts:36-369` — coordinator prompt + rules
  - `src/tools/AgentTool/loadAgentsDir.ts:296-755` — frontmatter loader
  - `src/tools/AgentTool/prompt.ts:66-212` — router-as-tool-description
  - `src/tools/AgentTool/runAgent.ts:248-479` — sub-agent spawn + permission scoping
  - `src/tools/AgentTool/built-in/exploreAgent.ts:67-82` — example read-only agent
- **openclaw** (local, mostly not applicable — see Researcher's finding):
  `/Users/huanglin12/myspace/openclaw`. Only `subagent-depth.ts` pattern
  is worth looking at (depth counter).
- **EvolvingAgent current code**:
  - `packages/core/src/planner/planner.ts:74-151` — where router mode branches
  - `packages/core/src/planner/planner.ts:122-128` — the fallback that must be inverted
  - `packages/core/src/agent.ts:114+` — the executor that needs the sub-agent dispatch
  - `packages/core/src/prompts/registry.ts` — where identity prompts register
  - `packages/core/src/multi-agent/coordinator.ts` — existing infra to evaluate for reuse
