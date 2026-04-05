# Evolving Agent

A self-evolving AI Agent system that learns from every interaction, accumulates skills, and improves its problem-solving capabilities over time.

## What Makes It Different

Unlike static AI tools (Claude Code, Cursor, etc.), Evolving Agent **evolves itself**:

- **Hooks evolve the self** — Agent improves its own thinking: context compression, prompt optimization, cost control, scheduled tasks
- **Skills are earned** — Reusable problem-solving patterns emerge from repeated successful experiences, not pre-coded
- **Tools extend the reach** — Agent creates its own tools when it encounters new problems
- **Memory decays** — Old, contradicted, or unreferenced memories are archived, not kept forever

## Architecture: Five Layers

```
  Human Analogy          Agent Layer              Evolvable?
  ════════════════════════════════════════════════════════════
  Skeleton/Organs        Core                     No  (human-maintained)
  Nervous System         Core Hooks               No  (safety baseline)
  Brain/Thinking         Evolved Hooks             Yes (Agent improves itself)
  Experience/Methods     Skills                    Yes (learned SOPs)
  Toolbox                Tools                     Yes (external capabilities)
```

**Key guarantee:** Core + Core Hooks ensure Agent always runs, even if all evolved components are disabled.

## Core Loop

```
  User Input
    │
    ▼
  [Hooks: before:plan]  ←── context compression, experience filtering
    │
  Planner ──── query memory for similar experiences + skills
    │
  [Hooks: before:tool-call, before:llm-call]  ←── safety, cache optimization
    │
  Executor ──── call tools, invoke LLM
    │
  [Hooks: after:tool-call, after:llm-call]  ←── cost tracking, quality monitoring
    │
  Output to user
    │
  [Hooks: before:reflect, after:reflect]  ←── memory admission filter
    │
  Reflector ──── analyze execution → extract experience → evolve skills/hooks
```

## Tech Stack

| Component | Choice |
|-----------|--------|
| Language | TypeScript (ESM) |
| Runtime | Node.js 22+ / Bun |
| Monorepo | pnpm workspace |
| LLM SDK | Vercel AI SDK (Anthropic, OpenAI, etc.) |
| Python Engine | CLI pipe mode (embedding, vector search, eval) |
| Storage | Local filesystem (JSON/MD) → vector DB (Phase 2+) |

## Project Structure

```
EvolvingAgent/
├── packages/
│   ├── core/          # Agent Core + Hook Runner + Memory + Tools
│   ├── cli/           # CLI Client
│   ├── server/        # HTTP/WebSocket Server (Phase 3)
│   └── web/           # Web UI (Phase 4)
├── python/            # Python AI Engine (Phase 2+)
├── data/              # Agent Workspace (evolved hooks, skills, tools, memory)
└── docs/
    ├── ARCHITECTURE.md   # Detailed architecture design
    └── STRATEGY.md       # Language strategy + project roadmap
```

## Roadmap

| Phase | Focus | Timeline |
|-------|-------|----------|
| **Phase 1** | Minimum viable loop: CLI + Planner/Executor/Reflector + basic tools + memory | ~1 week |
| **Phase 2** | Self-iteration: evolved hooks + skill system + dynamic tool generation + vector memory | ~2 weeks |
| **Phase 3** | Observability + verification + scheduled tasks + Feishu push + cost control | ~2 weeks |
| **Phase 4** | Web UI + multi-agent orchestration + MCP + Feishu bot + prompt self-optimization | ~3 weeks |

## Design Principles

1. **Evolution over configuration** — The Agent learns, not configures
2. **Hooks evolve the self, Tools extend the reach** — Internal improvement vs external capability
3. **Core never breaks** — All evolved components can be disabled; Agent still runs
4. **Two-layer safety** — Evolved hooks have fallbacks; Core hooks are the safety net
5. **Verify, don't assume** — Use observability to confirm whether actions were effective
6. **Start simple, grow smart** — JSON files before vector DBs, keyword match before embeddings

## License

MIT
