# Prompt Self-Optimization (Phase 4 / C)

> **Principle:** Source code is the **authoritative baseline**. The
> `data/prompts/active.json` file is a **runtime override layer** for prompts
> the optimizer (or a human) has accepted. The agent always reads through
> the override layer first and falls back to the source-code constant.

## What this gets you

Three prompt slots are managed:

| id | source-code constant | injected at |
|---|---|---|
| `planner` | `PLANNER_SYSTEM_PROMPT` (`packages/core/src/planner/planner.ts`) | `Planner.plan()` |
| `reflector` | `REFLECTOR_SYSTEM_PROMPT` (`packages/core/src/reflector/reflector.ts`) | `Reflector` system message |
| `conversational` | `CONVERSATIONAL_SYSTEM_PROMPT` (`packages/core/src/agent.ts`) | 4 sites in the conversational loop |

For each slot you can:

1. **View** baseline + currently active content + history of past accepted overrides.
2. **Trigger** an LLM-backed optimization run (manual, human-approved).
3. **Review** N generated candidates against a held-out eval subset, with a strict gate.
4. **Accept** the winning candidate (atomic write to `active.json` + history snapshot).
5. **Rollback** to a prior snapshot or all the way back to the source baseline.

## Resolution order

`PromptRegistry.get(id)` returns the first non-null layer:

```
transient (in-memory, used by sandbox eval loops)
    ↓
active.json   (durable runtime override)
    ↓
default       (source-code constant — always present)
```

This means: if you delete `active.json` the system reverts to baseline. If
you ship a new baseline in source, but the slot has an active override, the
override wins until rolled back.

## Files on disk

```
data/prompts/
  active.json                    # current overrides — atomic-written
  history/
    2026-04-07T19-12-03-planner.md   # one file per accepted change
```

`active.json` shape:

```json
{
  "version": 1,
  "entries": {
    "planner": {
      "content": "<full prompt body>",
      "updatedAt": 1712525523000,
      "note": "accepted from run pending-1712525001-x"
    }
  }
}
```

History snapshot — yaml frontmatter + markdown body:

```markdown
---
id: planner
timestamp: 2026-04-07T19:12:03.000Z
note: accepted from run pending-1712525001-x
previousLength: 1840
---

<full prompt body that was active BEFORE this change — lets you rollback>
```

## The optimization loop

`PromptOptimizer.optimize(targetId, count?)`:

1. Run baseline against the eval subset → record per-case pass/fail set.
2. Call `propose()` N times → get N candidate prompts.
3. For each candidate, install via `registry.withTransient(id, body, async () => {...})` and re-run the eval subset. Transient cleanup is guaranteed even on throw.
4. Apply the **gate**:
   - **Strict improvement** — pass rate strictly greater than baseline (ties rejected).
   - **No regression** — every case that the baseline passed must still pass under the candidate.
5. Sort accepted candidates best-first. Return an `OptimizationRun` object with full per-candidate detail (rationale, diff stats, gate verdict).

The optimizer is fully injectable: `propose: ProposeFn` and `evaluate: EvaluateFn` are plain functions you wire at construction time. Production code uses `createLLMProposer({ llm })` + `createEvalAdapter({ provider, promptRegistry, dataPath })`. Tests use fakes.

## How the sandbox eval propagates the override

This is the load-bearing wire. Without it, the inner Agents in `EvalRunner` would read the **outer** PromptRegistry (no transient set) and the candidate would never actually be tested.

```
PromptOptimizer
  └── registry.withTransient('planner', candidateBody, async () => {
        return await evaluate(cases)
      })
            │
            ▼
EvalRunner.run(cases)
  └── new SessionManager({ shared: { promptRegistry: this.deps.promptRegistry } })
            │
            ▼
SessionManager.buildSharedDeps()  ← uses passed-in registry instead of constructing fresh
            │
            ▼
new Agent({ shared: { promptRegistry } })
            │
            ▼
Planner / Reflector / conversational loop  ← all read registry.get(id)
            │
            ▼
Sees the transient override during the candidate's eval run
```

The same `PromptRegistry` instance must thread end-to-end. `EvalRunnerDeps.promptRegistry` is the optional escape hatch — if omitted, the inner SessionManager constructs its own (fine for stand-alone eval, broken for sandboxed optimization).

## API surface

### Core (`@evolving-agent/core`)

```typescript
import {
  PromptRegistry,
  PromptOptimizer,
  createLLMProposer,
  createEvalAdapter,
  PROMPT_IDS,
  PLANNER_SYSTEM_PROMPT,
  REFLECTOR_SYSTEM_PROMPT,
  CONVERSATIONAL_SYSTEM_PROMPT,
} from '@evolving-agent/core'
```

`SessionManager` exposes the shared singletons:

- `getPromptRegistry()` — the shared `PromptRegistry`
- `getPromptOptimizer(force?)` — lazy, loads `reasoning-* + instruction-*` eval subset
- `startOptimizationRun(targetId, count?)` — kicks off background, returns placeholder run id immediately
- `getOptimizationRun(runId)` / `listOptimizationRuns()` — for polling

Background runs are tracked in an in-memory `Map<runId, OptimizationRun>` with LRU eviction at 32 entries. Restarting the server loses in-flight runs; accepted changes persist via `active.json`.

### Web (`@evolving-agent/web`)

All routes mounted under `/api/prompts`:

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/`                  | list all 3 slots — `{id, baselineLength, activeLength?, source, preview}` |
| `GET`  | `/:id`               | full content for one slot — baseline + active + history |
| `GET`  | `/:id/history`       | history list (no body) |
| `POST` | `/:id/optimize`      | `{count?}` → `{runId}` (returns immediately, runs in background) |
| `GET`  | `/runs`              | recent runs |
| `GET`  | `/runs/:runId`       | full run detail (poll for status) |
| `POST` | `/:id/accept`        | `{runId, candidateIndex, note?}` → atomic-write active.json |
| `POST` | `/:id/rollback`      | `{timestamp?, note?}` → restore from history or to baseline |

### Web UI

`PromptsPage` at `/prompts`:

- Three cards (planner / reflector / conversational) with source badge (active = blue, baseline = gray) and preview.
- "Optimize" button kicks off a run; the runs table polls every 4 seconds.
- "View" opens a modal with full content + baseline + history (each snapshot has a "Rollback" button; there's a separate "Revert to baseline").
- Clicking a run opens a modal that polls every 2.5 seconds while running, then shows gate verdict + accepted candidates (expandable, with "Accept" button) + rejected candidates with reason.
- All destructive actions (rollback, accept) prompt for confirmation.

## When to use this

- **Use it for:** chasing a stable improvement on a held-out eval subset when you've already exhausted easy hand edits, and you have a representative case set you trust.
- **Don't use it for:** hot-fixing a single regression (just edit the source), shipping experimental phrasing without measurement (just edit the source), or any change you can't justify against the gate.

The strict gate is intentional. A candidate that ties the baseline is **rejected** — there's no upside to accepting churn that doesn't move the metric.

## Cost / safety notes

- Optimization is a **manual, human-approved** flow. There's no scheduler, no auto-trigger, no daemon. A run only happens when someone clicks "Optimize" (or hits the route directly).
- Each run costs `count + 1` baseline-eval LLM passes plus `count` candidate-generation calls. With the default eval subset of `reasoning-* + instruction-*` (~6-7 cases) and `count = 3`, that's modest but not free. Watch the metrics dashboard.
- Accepted candidates persist in `data/prompts/active.json`, which is **not** gitignored — commit it intentionally if you want the team to share the override, or `.gitignore` it locally if optimizations should stay per-environment.
- The author of an accepted change is recorded only as a free-text `note` field. There's no signing, no audit trail beyond the history snapshot file.

## Failure modes worth knowing

- **The proposer returns malformed JSON** — `createLLMProposer` is tolerant of raw / fenced / fenced-with-prose JSON, and silently drops anything it can't parse. The batch survives partial failures.
- **The eval subset is too small** — with 3 cases, a single flake can flip the gate. Add more cases before complaining about non-reproducible runs.
- **The transient override doesn't propagate** — if you build a custom `EvaluateFn`, you must thread `promptRegistry` through your inner SessionManager. The provided `createEvalAdapter` does this for you. If you forget, the optimizer will quietly evaluate the baseline three times in a row.
- **In-flight runs are lost on server restart** — accepted changes are not. If you `POST /optimize` and restart, the run id becomes a 404 but `active.json` is intact.
