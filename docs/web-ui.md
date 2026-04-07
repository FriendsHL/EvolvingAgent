# Web Dashboard (Phase 4 / D)

> **Principle:** the dashboard is the single pane of glass for everything the
> agent does. Every page reads from a small, well-defined REST surface, plus
> a single global SSE stream for live events. No page polls more than it has
> to, no page renders state it can't explain.

## What this gets you

Phase 4 / D delivered two new pieces of UI on top of the existing pages:

| Page | URL | Purpose |
|---|---|---|
| **Event Stream** | `/events` | A live, global feed of every agent event across all sessions, with type filters, pause / resume / clear, and an expandable raw payload view per row. |
| **Session Detail (rewritten)** | `/sessions/:id` | A tabbed view of one session's full lifecycle — timeline, plans, tool calls, cost, messages, reflections, and an embedded live tab that subscribes to the same SSE feed but filtered to this one session. |

D3 (Chat page experience upgrades — message editing, branch / resume, prompt
preview) was deferred to Phase 5 because it touches the agent core loop, not
just the UI surface.

D4 (Metrics page deepening) and D5 (unified ops dashboard) are tracked but
not yet scheduled — D5 specifically depends on E (knowledge auto-generation)
landing first.

## SSE event stream

A single endpoint emits every `AgentEvent` from every active session:

```
GET /api/events
Content-Type: text/event-stream
```

Event payload — `AgentEvent` from `@evolving-agent/core` with a `sessionId`
field injected by the broadcast layer:

```typescript
{
  type:       'planning' | 'executing' | 'tool-call' | 'tool-result'
            | 'reflecting' | 'message' | 'error' | 'hook'
  data:       unknown    // shape depends on type — see below
  timestamp:  string     // ISO-8601
  sessionId:  string     // injected by routes/chat.ts before broadcast
}
```

### Per-type data shapes

The dashboard renders these defensively (every shape is "best-effort") because
the agent loop emits events from many call sites:

| `type` | `data` shape | Emitted from |
|---|---|---|
| `planning` | string status **or** full `Plan` object (`{goal, rationale, steps[]}`) | `Agent.processMessage`, `Agent.processMessageStream` planner phase |
| `executing` | string status **or** `ExecutionStep` | execution loop, sub-agent dispatch |
| `tool-call` | tool invocation payload | `ToolRegistry.execute()` |
| `tool-result` | tool return value | `ToolRegistry.execute()` |
| `reflecting` | string status **or** structured reflection | reflector phase |
| `message` | `{role, content}` | every conversational turn |
| `error` | error message string | thrown anywhere in the loop |
| `hook` | description string | hook runner status, init, graduation events |

### Server-side broadcast

`packages/web/src/server/index.ts` keeps an in-memory `Set<ReadableStreamDefaultController>`
of subscribed SSE clients and exposes a `broadcast(event)` callback. The chat
route (`packages/web/src/server/routes/chat.ts`) is currently the only place
that calls it — at three sites: session create, session resume, and message
send. Each site wires `agent.onEvent((ev) => broadcast({sessionId, ...ev}))`.

If you wire a new agent code path that should appear in the live feed, follow
the same pattern: pass `broadcast` into the route, attach via `onEvent`, and
inject the `sessionId` so the dashboard can route the event to the right
session view.

## Client hook: `useSSE`

`packages/web/src/client/hooks/useSSE.ts` is the **only** place that opens an
`EventSource`. Both the global `EventStreamPage` and the per-session "Live"
tab in `SessionDetailPage` consume it.

```typescript
const { events, connected, paused, pause, resume, clear, totalReceived } =
  useSSE<MyEventShape>('/api/events', { capacity: 200 })
```

| Field | Meaning |
|---|---|
| `events` | FIFO ring buffer up to `capacity`. Older events are evicted. |
| `connected` | True between `onopen` and `onerror`. |
| `paused` | If true, incoming events are still counted in `totalReceived` but not appended to `events`. |
| `pause` / `resume` | Toggle the paused flag. The hook reads the flag from a ref so toggling does **not** re-attach the EventSource. |
| `clear` | Empties `events`. Does not reset `totalReceived`. |
| `totalReceived` | Lifetime count, including evicted and paused events. |

## Component: `<EventStream />`

`packages/web/src/client/components/EventStream.tsx` is the shared UI that
both consumers render. The component:

1. Subscribes via `useSSE`.
2. Renders a header with connection state, three counters (shown / buffered / total), and pause / clear buttons.
3. Renders a row of type-filter chips — clicking a chip toggles whether that event type is displayed.
4. Renders the filtered events newest-at-bottom, with click-to-expand raw JSON.
5. Optionally hides the session column when embedded inside a page that already knows the session.

```tsx
// Global page
<EventStream height="calc(100vh - 180px)" />

// Embedded in SessionDetailPage's Live tab
<EventStream sessionId={session.id} showSessionColumn={false} height="600px" />
```

The component takes `sessionId` as a **display-side filter** — the SSE
endpoint itself does not support per-session filtering, all clients receive
all events. If the dashboard ever needs to scale to many simultaneous live
viewers, the right fix is server-side fan-out, not removing the global
endpoint.

## SessionDetailPage tabs

The new `pages/SessionDetailPage.tsx` is a single-file tabbed view. All seven
tabs derive from the **same** `PersistedSession` object that
`GET /api/sessions/:id` already returned — no new server endpoints were
added in D2.

| Tab | Source | Notes |
|---|---|---|
| **Timeline** | `events[]` chronological | Click any row to expand raw payload. |
| **Plans** | `events.filter(e => e.type === 'planning' && isPlanLike(e.data))` | Renders each emitted `Plan` with goal / rationale / steps tree. |
| **Tool calls** | Pair-walk `events[]`, matching each `tool-call` with the next `tool-result` | Unpaired calls show "no result" badge. |
| **Cost** | `session.totalCost` + `totalTokens` + derived event-type histogram + tool name frequency | A per-call breakdown is **not** in this tab — it requires the metrics collector to expose per-step attribution, which is a follow-up. |
| **Messages** | `messages[]` | The pre-existing conversation view, unchanged. |
| **Reflection** | `events.filter(e => e.type === 'reflecting' && typeof e.data !== 'string')` | Filters out the bare "Reflecting on execution…" status strings; only structured reflections show here. |
| **Live** | `<EventStream sessionId={id} showSessionColumn={false} />` | The same component the global page uses. |

The page is fully client-derived: refreshing the URL re-fetches the
PersistedSession, all tabs recompute via `useMemo`, no incremental loading
state to manage. If a session has 10k events the page will get slow — that
is a problem for D4 / D5 if it ever materializes.

## Things this design intentionally does *not* do

- **No per-session SSE endpoints.** All clients see everything; per-session views filter on the client. This is fine because the dashboard is a single-operator tool, not a public API.
- **No authentication on `/api/events`.** Same reason. If the dashboard ever ships to a multi-tenant deployment, the SSE endpoint and the broadcast set need to be partitioned, not the page logic.
- **No event persistence beyond `PersistedSession.events[]`.** If the server restarts, in-flight events are lost. Accepted state (messages, sessions) survives because it lives in the session store. The live event stream is intentionally ephemeral.
- **No virtual scrolling.** With a 200-event capacity on the live page and typical session sizes under a few thousand events, it isn't yet worth the complexity. Revisit if a real session blows past ~5000 events.

## When to add a new event type

If you find yourself wanting to thread a new state out of the agent loop into
the dashboard, the path is:

1. Add the new value to the `AgentEventType` union in `packages/core/src/types.ts`.
2. Call `this.emit({type: '...', data: ..., timestamp: ...})` from the relevant agent site.
3. Add an entry to `EVENT_ICONS` and `TYPE_STYLE` in `EventStream.tsx` and to `EVENT_ICONS` in `SessionDetailPage.tsx`.
4. If the event has structured data the timeline tab should highlight, add a tab-specific renderer (or just rely on the timeline tab's generic JSON expansion — the bar to add a tab is high).

That's the whole pipeline. The dashboard does **not** need a schema change,
a route change, or a build step — the broadcast layer is type-blind on
purpose.
