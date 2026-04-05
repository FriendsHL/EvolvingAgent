# Tool System

> Part of [Evolving Agent Architecture](../ARCHITECTURE.md)

## Three Layers

```
  Layer 1: Foundation (Agent survival)
  ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ shell    │ │ file-rw  │ │ http     │
  └──────────┘ └──────────┘ └──────────┘

  Layer 2: Development (Agent self-iteration)
  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ git      │ │ code-    │ │ code-    │ │ test-    │
  │          │ │ search   │ │ edit     │ │ runner   │
  └──────────┘ └──────────┘ └──────────┘ └──────────┘

  Layer 3: Observability (Agent self-verification)
  ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ metrics  │ │ log-     │ │ trace    │
  │ query    │ │ search   │ │          │
  └──────────┘ └──────────┘ └──────────┘

  Layer ∞: Dynamic (Agent self-created)
  ┌──────────────────────────────────────────┐
  │  Agent encounters new need → writes code │
  │  → tests → registers as new tool         │
  │  → saves to skill store                  │
  └──────────────────────────────────────────┘
```

## Self-Iteration via ReAct Loop

Agent writes code using ReAct (Think → Edit → Test → Fix), not one-shot generation:

```
  Planner: "Need a Kafka consumer lag checker tool"
    │
  Executor (ReAct loop):
    ├─ Think: "Need to create a tool calling Kafka admin API"
    ├─ Act: code-edit → create data/tools/kafka-lag.ts
    ├─ Observe: test-runner → FAIL: Kafka address not configured
    ├─ Think: "Need to read KAFKA_BROKERS from env"
    ├─ Act: code-edit → modify to read env var
    ├─ Observe: test-runner → PASS
    └─ Done: tool-registry → register "kafka-lag"
```

## Tool Safety

- Tools written by Agent go to `data/tools/` (isolated from Core)
- Sandbox verification: syntax check, security check (no Core imports, no process.exit), test run
- Runtime isolation: dynamic tools run via child_process or vm with timeout
- Crash doesn't affect Agent Core
- Version history in `data/tools/.history/` for rollback
