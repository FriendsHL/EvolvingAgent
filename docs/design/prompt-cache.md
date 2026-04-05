# Prompt Cache Strategy

> Part of [Evolving Agent Architecture](../ARCHITECTURE.md)

## Four-Layer Prompt Structure

Prompts are structured by stability (most stable first) to maximize cache hit:

```
  ┌───────────────────────────────────┐ ← cache breakpoint 1
  │  Layer 1: System Prompt (very stable)
  │  • Agent identity, behavior rules
  │  • Tool definitions (built-in)
  │  • Output format requirements
  │  → ~100% cache hit
  ├───────────────────────────────────┤ ← cache breakpoint 2
  │  Layer 2: Context (fairly stable)
  │  • Skill store summary (changes daily)
  │  • Knowledge store summary
  │  • User preferences
  │  → 80-90% cache hit
  ├───────────────────────────────────┤ ← cache breakpoint 3
  │  Layer 3: Task Context (moderate change)
  │  • Conversation history
  │  → 50-70% cache hit
  ├───────────────────────────────────┤
  │  Layer 4: Current Input (changes every time)
  │  • User's current message
  │  • Related experiences (retrieval results)
  │  • Tool execution results
  │  → 0% cache
  └───────────────────────────────────┘
```

**Why Related Experiences in Layer 4?** Each query retrieves different experiences. Putting them in Layer 2/3 would break cache for subsequent layers. Exception: Sub-Agent scenarios where Main pre-retrieves shared experiences — those go in Layer 3.

## LLM Provider Cache Comparison

| | Anthropic | OpenAI | Google Gemini | DeepSeek |
|---|---|---|---|---|
| **Cache mechanism** | Manual breakpoints | Automatic (prefix match) | Optional (explicit cache object) | Automatic (prefix match) |
| **Manual marking?** | Yes (`cache_control`) | No (auto) | Optional | No (auto) |
| **Min cache unit** | 1024 tokens (Sonnet) | 1024 tokens | 32K tokens | 64 tokens |
| **Max breakpoints** | 4 | Unlimited | 1 | Unlimited |
| **TTL** | 5 min | ~5-10 min | Configurable (up to 1 hour) | Minutes |
| **Write surcharge** | 1.25x | 0x (free) | Depends on TTL | 0x |
| **Read discount** | 0.1x (90% off) | 0.5x (50% off) | 0.25x (75% off) | 0.1x (90% off) |
| **Cache metrics in API** | Yes (detailed) | Yes (cached_tokens) | Yes | Yes |

**Key insight:** Our four-layer prompt structure benefits ALL providers — stable prefix = automatic cache hit for OpenAI/DeepSeek, and well-placed breakpoints for Anthropic.

## Framework Selection: Vercel AI SDK

### Why Vercel AI SDK

| Framework | Stars | Cache Support | Assessment |
|-----------|-------|--------------|------------|
| **Vercel AI SDK** | ~22.5K | Messages via `providerMetadata`, v6 adds tool-level | **Chosen** — best TS multi-provider SDK |
| Mastra | ~21.9K | Based on Vercel, but agent pipeline strips `providerOptions` | Cache buggy |
| LangChain.js | ~17.2K | Dedicated `anthropicPromptCachingMiddleware` | Too heavy — conflicts with our own Agent framework |
| Genkit | ~5.5K | `cacheControl()` helper, Google-backed | Smaller community, Anthropic support is new |
| LlamaIndex.TS | ~4K | Python-first, TS cache unclear | TS is second-class |

### Why NOT LangChain.js

LangChain has the most explicit cache support, but:

1. **Abstraction conflict** — We ARE an Agent framework. LangChain also provides Agent/Memory/Chain/Tool abstractions. Using it means our Hook system vs their Callbacks, our Memory vs their Memory, our Sub-Agent vs their AgentExecutor — constant friction.
2. **We only need the LLM call layer** — Vercel AI SDK does `generateText()` + `streamText()` + Tool calling + provider abstraction. Nothing more. LangChain gives you the whole kitchen when you only need the stove.
3. **Dependency weight** — LangChain pulls ~50+ packages. Vercel AI SDK pulls ~15. Matters for CLI startup time.
4. **API instability** — LangChain.js has frequent breaking changes (v0.1 → v0.2 → v0.3). JS version lags behind Python.
5. **Community sentiment** — Known as "the jQuery of AI" — useful for prototypes, painful for custom frameworks.

**Analogy:** We're building a car. We need to buy an engine (Vercel AI SDK), not buy an entire car and then replace everything except the engine (LangChain).

### Fallback Strategy

```
  Primary: Vercel AI SDK + providerMetadata for cache markers
  
  If Vercel SDK has issues with a specific provider's cache:
  → Locally drop down to native SDK for that provider
  → No need to replace the entire framework

  // Provider-aware cache helper
  function withCache(message: Message, provider: string): Message {
    if (provider === 'anthropic') {
      return {
        ...message,
        providerMetadata: {
          anthropic: { cacheControl: { type: 'ephemeral' } }
        }
      }
    }
    return message  // OpenAI/DeepSeek: auto-cache, no marking needed
  }
```

## Implementation with Vercel AI SDK

### Anthropic Cache Control

```typescript
import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'

const result = await generateText({
  model: anthropic('claude-sonnet-4-20250514'),
  messages: [
    // ===== Layer 1: System Prompt (cache breakpoint 1) =====
    {
      role: 'system',
      content: SYSTEM_PROMPT,
      providerMetadata: {
        anthropic: { cacheControl: { type: 'ephemeral' } }
      }
    },

    // ===== Layer 2: Skills + Knowledge (cache breakpoint 2) =====
    {
      role: 'user',
      content: SKILL_KNOWLEDGE_SUMMARY,
      providerMetadata: {
        anthropic: { cacheControl: { type: 'ephemeral' } }
      }
    },
    { role: 'assistant', content: 'Understood.' },

    // ===== Layer 3: Conversation History (cache breakpoint 3) =====
    ...conversationHistory,
    {
      ...lastHistoryMessage,
      providerMetadata: {
        anthropic: { cacheControl: { type: 'ephemeral' } }
      }
    },

    // ===== Layer 4: Current Input (no cache) =====
    { role: 'user', content: currentUserMessage },
  ],
})

// Cache metrics
const cacheRead = result.providerMetadata?.anthropic?.cacheReadInputTokens ?? 0
const cacheWrite = result.providerMetadata?.anthropic?.cacheCreationInputTokens ?? 0
```

### Anthropic API Request Structure

```
  Anthropic processes cache in this order: system → tools → messages
  
  POST /v1/messages
  {
    "system": [{ "text": "...", "cache_control": {...} }],      // breakpoint 1
    "tools": [{ "name": "shell", ..., "cache_control": {...} }], // breakpoint 2
    "messages": [...]                                             // breakpoint 3
  }

  Tools naturally sit between system and messages.
  Tool definitions sorted alphabetically → consistent cache keys.
```

### Prompt Builder

```typescript
// packages/core/src/llm/prompt-builder.ts

function buildMessages(config: PromptConfig): Message[] {
  const messages: Message[] = []

  // Layer 1: System (most stable)
  messages.push(withCache({
    role: 'system',
    content: [SHARED_PREFIX, agentPrompt].join('\n\n'),
  }, config.provider))

  // Layer 2: Skills + Knowledge (changes daily at most)
  if (config.skills.length || config.knowledge.length) {
    messages.push(withCache({
      role: 'user',
      content: formatSkillsAndKnowledge(config.skills, config.knowledge),
    }, config.provider))
    messages.push({ role: 'assistant', content: 'Understood.' })
  }

  // Layer 3: Conversation history (grows but prefix is stable)
  if (config.history.length) {
    const history = [...config.history]
    history[history.length - 1] = withCache(history[history.length - 1], config.provider)
    messages.push(...history)
  }

  // Layer 4: Current input + retrieved experiences (no cache)
  messages.push({
    role: 'user',
    content: [
      config.experiences.length ? formatExperiences(config.experiences) : '',
      config.currentInput,
    ].filter(Boolean).join('\n\n'),
  })

  return messages
}

// Tools: sorted alphabetically for stable cache
function buildTools(tools: Tool[]): Record<string, ToolDef> {
  return Object.fromEntries(
    [...tools].sort((a, b) => a.name.localeCompare(b.name))
      .map(t => [t.name, { description: t.description, parameters: t.parameters }])
  )
}
```

## Cache Anti-Patterns

```
  ✗ Dynamic content in stable layer:
    System prompt includes "Current time: 2026-04-05T10:30:00Z"
    → L1 changes every second → all cache miss
  ✓ Fix: put time in L4 (current input)

  ✗ Unstable tool order:
    tools: [shell, file-read, http] vs [http, shell, file-read]
    → tools sit between system and messages → messages cache all miss
  ✓ Fix: sort tools alphabetically, always

  ✗ LLM-generated skill summaries:
    Each time LLM rewrites skill descriptions differently
    → L2 changes → L3 cache miss
  ✓ Fix: use fixed template formatting, not LLM prose

  ✗ Tool results with timestamps in history:
    { "output": "query at 10:30:00, requestId: abc123" }
    → history changes → breaks L3 cache
  ✓ Fix: strip timestamps/requestIds before storing in history
```

## Minimum Cache Unit

```
  Anthropic: 1024 tokens minimum for cache to activate

  Our layer sizes:
  L1 (system): ~800-1500 tokens
  L2 (skills):  ~300-2000 tokens
  Tools:        ~500-1500 tokens

  Phase 1 concern: system prompt alone might be < 1024
  Solution: Anthropic counts system + tools together as prefix
  system (800) + tools (500) = 1300 > 1024 → cache activates
```

## Multi-Turn Cache Growth

```
  Turn 1:  [L1 ✦][L2 ✦][L3: empty][L4: query]      → cold start
  Turn 2:  [L1 ✓][L2 ✓][L3: turn1 ✦][L4: query]    → L1-2 hit
  Turn 3:  [L1 ✓][L2 ✓][L3: turn1-2 ✓✦][L4: query] → L1-3 partial hit
  Turn 10: [L1 ✓][L2 ✓][L3: turn1-9 ✓][L4: query]  → massive hit

  Long conversations get cheaper over time.
  Only L4 (~200 tokens) is full price. Rest (~5000) is cache (10%).
```

## Reflector Cache Optimization

```
  Reflector is called after every task — high frequency, highly templated.

  Reflector Prompt:
  ┌───────────────────────────────────────────┐
  │ System: "Analyze execution, output JSON..." │ ← never changes → cache
  ├───────────────────────────────────────────┤
  │ User: "Execution record: { ... }"          │ ← changes each time
  └───────────────────────────────────────────┘

  System ~500 tokens → cache hit (10% cost)
  Execution record ~1000 tokens → full price
  Model: Haiku (cheapest) → combined cost ≈ negligible
```

## Cost Model

```
  Anthropic Claude Sonnet pricing:
  • Normal input:   $3 / 1M tokens
  • Cache write:    $3.75 / 1M tokens (1.25x)
  • Cache read:     $0.30 / 1M tokens (0.1x)
  • Output:         $15 / 1M tokens

  Typical 10-turn conversation:
  Without cache: ~$0.078
  With cache:    ~$0.012
  Savings:       ~85%
```

## Token Cache Observability

Three layers of cache metrics, collected via `after:llm-call` Core Hook:

**Layer 1: Per-call metrics** (JSONL, one file per day)

```
  { callId, agent, session, model, timestamp,
    tokens: { prompt, completion, cacheWrite, cacheRead },
    cacheHitRate, effectiveCost, savedCost }
```

**Layer 2: Task-level summary**

```
  { taskId, agent, session,
    totalCalls, totalPromptTokens, totalCacheRead,
    cacheHitRate, duration, cost, savedCost }
```

**Layer 3: Session / daily view**

```bash
$ evolve stats
Session s-001 (active 23min)
┌──────────────────────────────────────────────────────┐
│ Token Usage                                          │
│ Total:    prompt 18.2K  completion 5.1K              │
│ Cache:    read 14.8K    write 3.4K                   │
│ Hit Rate: 81.3%                                      │
│ Cost:     $0.0034 (saved $0.0126 via cache)          │
├──────────────────────────────────────────────────────┤
│ Agents                                               │
│ Agent              Calls  Tokens   Cache%   Cost     │
│ main               4      8.2K     72.0%    $0.0018  │
│ sub-langgraph      3      5.1K     94.4%    $0.0006  │
│ sub-crewai         3      4.9K     95.1%    $0.0005  │
│ sub-autogen        2      5.1K     93.8%    $0.0005  │
└──────────────────────────────────────────────────────┘

$ evolve stats --daily
Date        Sessions  Tokens     Cache%  Cost     Saved
2026-04-05  3         42.1K      78.2%   $0.012   $0.043
2026-04-04  5         68.3K      82.1%   $0.018   $0.082
This week   8         110.4K     80.5%   $0.030   $0.125
```

**Cache health alert** (Cron Hook): daily check, alert if cacheHitRate < 50%.

**Storage:** `data/metrics/calls/` (JSONL), `data/metrics/daily/` (JSON), `data/metrics/agents/` (JSON).

## Token Budget Management

```
  Per-task budget (configurable):
  • Total: 50K tokens
  • Planner: 10K
  • Executor (per step): 5K × N
  • Reflector: 5K
  • Sub-Agent pool: 50% of total (see Sub-Agent Token Budget Control)

  Over-budget strategy:
  1. Warn user: "Task consumed XX tokens, continue?"
  2. Auto-downgrade: Sonnet → Haiku
  3. Context reduction: keep top 3 experiences instead of 10
```
