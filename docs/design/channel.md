# Channel Architecture

> Part of [Evolving Agent Architecture](../ARCHITECTURE.md)

```
  ┌─────────────────────────────────────────────────────┐
  │                 Agent Core                           │
  │                    │                                 │
  │                    ▼                                 │
  │  ┌─────────────────────────────────┐                │
  │  │         Channel Manager          │                │
  │  │  • Unified message interface     │                │
  │  │  • Message routing               │                │
  │  │  • Bidirectional (receive+push)  │                │
  │  └──────────┬──────────────────────┘                │
  │             │                                        │
  │    ┌────────┼────────┬────────┬────────┐            │
  │    ▼        ▼        ▼        ▼        ▼            │
  │  ┌─────┐ ┌─────┐ ┌──────┐ ┌──────┐ ┌──────┐       │
  │  │ CLI │ │ Web │ │Feishu│ │DaXiang│ │Slack │       │
  │  │     │ │ WS  │ │ Bot  │ │ Bot  │ │ Bot  │       │
  │  └─────┘ └─────┘ └──────┘ └──────┘ └──────┘       │
  └─────────────────────────────────────────────────────┘

  interface Channel {
    id: string
    send(message: AgentMessage): Promise<void>
    onMessage(handler: MessageHandler): void
    supportsStreaming: boolean
    supportsRichContent: boolean
  }
```

## Phase Rollout

- Phase 1: CLI only
- Phase 3: + Server (HTTP/WS) + Feishu webhook (simple push, ~10 lines)
- Phase 4: + Feishu Bot (bidirectional) + Web UI
