# Hook System (Inspired by Claude Code)

> Part of [Evolving Agent Architecture](../ARCHITECTURE.md)

## Design Philosophy

Hooks = evolving the Agent itself (innate capabilities).
Skills/Tools = giving the Agent external capabilities.

Claude Code has 24+ hook trigger points with three execution modes (Void, Modifying, Claiming) and error isolation via `catchErrors`. We adopt the same patterns, adapted for the Agent evolution loop.

## Hook Trigger Points

```
  User Input
    │
    ▼
  ● before:plan (Modifying)
  │  Can modify: input, context, retrieved experiences
  │  Use: context compression, input preprocessing, experience filtering
  │
  ▼
  Planner
    │
    ▼
  ● after:plan (Modifying)
  │  Can modify: generated execution plan
  │  Use: plan review, risk assessment, step optimization
  │
  ▼
  ● before:tool-call (Modifying)        ← per tool call
  │  Can modify: tool parameters
  │  Use: param validation, permission check, dangerous op interception
  │
  ▼
  Executor (tool call)
    │
    ▼
  ● after:tool-call (Modifying)         ← per tool call
  │  Can modify: tool result
  │  Use: result formatting, anomaly detection, cost recording
  │
  ▼
  ● before:llm-call (Modifying)         ← per LLM call
  │  Can modify: prompt, model selection, parameters
  │  Use: prompt cache optimization, model downgrade, context trimming
  │  ← THE most critical evolution point
  │
  ▼
  LLM Call
    │
    ▼
  ● after:llm-call (Void)               ← observation only
  │  Read-only: LLM response, token consumption
  │  Use: cost tracking, quality monitoring, cache hit stats
  │
  ▼
  ● before:reflect (Modifying)
  │  Can modify: data sent to Reflector
  │  Use: decide whether to skip reflection, compress reflection input
  │
  ▼
  Reflector
    │
    ▼
  ● after:reflect (Modifying)
  │  Can modify: reflection result, experience to store
  │  Use: memory admission filtering, experience quality scoring
  │
  ▼
  ● on:error (Void)                     ← on any error
  │  Read-only: error information
  │  Use: error stats, alerting, auto-degradation decisions
  │
  ══ Independent of conversation ══
  │
  ● cron (Void)                          ← scheduled triggers
  │  Use: periodic inspection, memory cleanup, health check, proactive push
  │
  ● on:startup (Void)                    ← Agent startup
  │  Use: environment check, cache loading, state recovery
```

## Three Execution Modes (from Claude Code)

```typescript
// Mode 1: Void — parallel, fire-and-forget (observation/logging)
// Used for: after:llm-call, on:error, cron, on:startup
async function runVoidHooks(hookName, event) {
  const hooks = getEnabledHooks(hookName)
  await Promise.all(hooks.map(h => safeExec(h, event)))
  // All hooks run in parallel, any failure doesn't affect others
}

// Mode 2: Modifying — sequential, can modify data flow (enhance/filter)
// Used for: before:plan, before:llm-call, after:reflect, etc.
async function runModifyingHooks(hookName, event, data) {
  const hooks = getEnabledHooks(hookName).sort(byPriority)
  let result = data
  for (const hook of hooks) {
    const modified = await safeExec(hook, event, result)
    if (modified !== undefined) {
      result = merge(result, modified)
    }
    // Hook fails → skip it, continue with previous result
  }
  return result
}

// Mode 3: Claiming — sequential, first-match wins (routing/decisions)
// Used for: future Sub-Agent task routing
async function runClaimingHooks(hookName, event) {
  for (const hook of getEnabledHooks(hookName).sort(byPriority)) {
    const result = await safeExec(hook, event)
    if (result?.handled) return result
  }
  return undefined
}
```

## Trust Layers

```
  Layer 0: Core Hooks (built-in, immutable)
  ═════════════════════════════════════════
  priority: 100
  • context-window-guard   (before:llm-call) — hard context window protection
  • cost-hard-limit        (before:llm-call) — hard cost ceiling
  • safety-check           (before:tool-call) — dangerous operation interception

  Layer 1: Evolved-Verified (evolved + battle-tested)
  ══════════════════════════════════════════════════
  priority: 50
  Agent created → tests passed → ran N times without failure → upgraded to verified
  Examples: smart-context-compressor, prompt-cache-optimizer, memory-quality-filter

  Layer 2: Evolved-New (evolved + probationary)
  ════════════════════════════════════════════
  priority: 10
  Freshly created by Agent, in observation period
  fallbackBehavior fixed to 'skip' (fail = skip)
  10 consecutive successes → auto-upgrade to verified
```

## Hook Data Structure

```typescript
interface Hook {
  id: string
  name: string
  description: string
  trigger: HookTrigger
  priority: number
  enabled: boolean
  source: 'core' | 'evolved-verified' | 'evolved-new'

  handler: string  // Function path or script path

  health: {
    consecutiveFailures: number
    lastError?: string
    lastSuccess?: string
    totalRuns: number
    successRate: number
  }

  safety: {
    timeout: number
    maxRetries: number
    fallbackBehavior: 'skip' | 'abort' | 'use-default'
    canBeDisabledByAgent: boolean
  }

  // For cron hooks
  schedule?: string  // cron expression
}

type HookTrigger =
  | 'before:plan' | 'after:plan'
  | 'before:tool-call' | 'after:tool-call'
  | 'before:llm-call' | 'after:llm-call'
  | 'before:reflect' | 'after:reflect'
  | 'on:error' | 'on:startup' | 'cron'
```

## Safety Shell (Error Isolation)

Every hook runs inside a Safety Shell (inspired by Claude Code's `catchErrors: true`):

```
  try {
    result = await Promise.race([
      hook.execute(context),
      timeout(hook.safety.timeout)
    ])
    hook.health.consecutiveFailures = 0
  } catch (error) {
    hook.health.consecutiveFailures++

    if (consecutiveFailures >= 3) {
      hook.enabled = false  // Immediately disable
      scheduleHeal(hook, error)  // Async self-heal, doesn't block
    }

    // Fallback — main flow never interrupted
    switch (hook.safety.fallbackBehavior) {
      case 'skip':        return context        // Skip hook, use original data
      case 'use-default': return defaultHandler  // Use built-in default
      case 'abort':       throw error           // Only for critical core hooks
    }
  }
```

## Self-Heal Flow

```
  Hook fails 3 consecutive times
       │
       ▼
  Step 1: Immediately disable hook
  → Main flow unaffected (fallback kicks in)
       │
       ▼
  Step 2: Diagnose (async, in background)
  → Agent analyzes error: code bug? env issue? logic error?
       │
       ├─── Core Hook → Don't modify, fall back to default, report to user
       │
       └─── Evolved Hook → Attempt repair:
            │
            ├── LLM analyzes error
            ├── Generates fix
            ├── Sandbox test
            │     │
            ├── Pass → Re-enable, version++, reset to evolved-new
            └── Fail → Archive hook permanently

  CRITICAL: Self-heal logic does NOT go through the Hook chain.
  → Prevents recursive dependency / deadlock.
  → Uses independent LLM call with minimal prompt.
```

## Context Compression Evolution Example

```
  Initial state:
  Core hook: context-window-guard (before:llm-call, priority=100)
  Strategy: brute-force truncation from oldest messages

  Problem:
  User defines variable X in message #5
  At message #30, guard truncates message #5
  Agent: "I don't know what X is"
  User corrects: "I defined it earlier!"

  Agent self-evolution:
  1. Reflector detects correction signal
  2. Analyzes: context truncation lost key definition
  3. Creates evolved hook: smart-compressor (before:plan, priority=50)
     - Identifies "definitional" messages (variable defs, decisions)
     - Marks them as pinned (never compressed)
     - Summarizes remaining messages via Haiku
  4. Sandbox test with historical conversations → passes
  5. Registered as evolved-new

  Runtime hook chain for before:llm-call:
  1. [evolved] smart-compressor (priority=50) → intelligent compression
     If fails? → Skip, use original messages
  2. [core] context-window-guard (priority=100) → hard truncation safety net
     If smart-compressor didn't compress enough → this catches it

  Two-layer protection: evolved hook fails → core hook catches.
```

## Scheduled Tasks (Cron Hooks)

Scheduled tasks are cron-triggered hooks, not Skills:

```
  data/hooks/cron/
  ├── memory-cleanup.ts         # Built-in: daily memory cleanup
  ├── health-check.ts           # Built-in: hourly self-check
  ├── kafka-monitor.ts          # Evolved: Agent-created monitoring
  └── daily-report.ts           # Evolved: Agent-created daily report

  Cron scheduler is part of Core (immutable).
  Cron hooks are evolvable — Agent can add/modify/disable them.
  Failed cron hooks auto-disable after 3 consecutive failures.
```

## Hook vs Skill vs Tool

| | Hook | Skill | Tool |
|---|------|-------|------|
| What | Agent internal middleware | Reusable task template | External capability |
| Triggered by | System events (auto) | Planner match | Executor call |
| Changes | Agent's behavior/thinking | Agent's problem-solving strategy | What Agent can do |
| Analogy | Neural reflexes / instincts | Experience-based SOPs | Tools in hand |
| Examples | Context compression, memory filter, cost control, cron tasks | "Debug P99" steps, "Write MCP Server" template | shell, HTTP, Kafka query |
