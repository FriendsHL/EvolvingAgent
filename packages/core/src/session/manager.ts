import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'

import { Agent, type AgentSharedDeps } from '../agent.js'
import { ExperienceStore } from '../memory/experience-store.js'
import { Embedder } from '../memory/embedder.js'
import { SkillRegistry } from '../skills/skill-registry.js'
import { KnowledgeStore } from '../knowledge/knowledge-store.js'
import { ToolRegistry } from '../tools/registry.js'
import { LLMProvider, type ProviderConfig, type PresetName } from '../llm/provider.js'
import { BudgetManager, loadBudgetConfig } from '../metrics/budget.js'
import { CacheMetricsRecorder } from '../metrics/cache-metrics.js'
import { HookRunner } from '../hooks/hook-runner.js'
import { HookScheduler } from '../hooks/hook-scheduler.js'
import {
  createCacheHealthAlert,
  type CacheHealthAlert,
  type CacheHealthAlertOptions,
} from '../hooks/core-hooks/cache-health-alert.js'
import { ChannelRegistry } from '../channels/index.js'
import type { CacheHealthAlertEvent } from '../channels/index.js'
import { MCPManager } from '../mcp/manager.js'
import { shellTool } from '../tools/shell.js'
import { fileReadTool } from '../tools/file-read.js'
import { fileWriteTool } from '../tools/file-write.js'
import { httpTool } from '../tools/http.js'
import { browserTool } from '../tools/browser.js'
import {
  createMetricsQueryTool,
  createLogSearchTool,
  createTraceTool,
} from '../tools/observability/index.js'
import { webSearchSkill } from '../skills/builtin/web-search.js'
import { summarizeUrlSkill } from '../skills/builtin/summarize-url.js'
import { selfRepairSkill } from '../skills/builtin/self-repair.js'
import { githubSkill } from '../skills/builtin/github.js'
import { codeAnalysisSkill } from '../skills/builtin/code-analysis.js'
import { fileBatchSkill } from '../skills/builtin/file-batch.js'
import { scheduleSkill } from '../skills/builtin/schedule.js'
import { dataExtractSkill } from '../skills/builtin/data-extract.js'

import { Session } from './session.js'
import type {
  CreateSessionInput,
  PersistedSessionRecord,
  SessionMetadata,
} from './types.js'

export interface SessionManagerDeps {
  /** Path to the data root (same one Agent uses for `dataPath`). */
  dataPath: string
  /** Optional explicit provider config; otherwise auto-detected. */
  provider?: ProviderConfig | PresetName
  /** Pre-built shared services. Any field omitted will be constructed by `init()`. */
  shared?: Partial<AgentSharedDeps>
  /** Override the default sessions directory (defaults to `<dataPath>/sessions`). */
  sessionsDir?: string
  /**
   * Tuning + sink for the system-level cache-health-alert cron hook.
   * Omit to use defaults; pass `{ enabled: false }` to disable entirely.
   */
  cacheHealthAlert?: CacheHealthAlertOptions & { enabled?: boolean }
  /**
   * MCP integration. By default the manager will look for
   * `<dataPath>/config/mcp.json` and load whatever it finds — if the file
   * is missing this is a quiet no-op. Pass `{ enabled: false }` to skip
   * MCP loading entirely (useful for tests or air-gapped environments).
   */
  mcp?: { enabled?: boolean }
}

const DEFAULT_TITLE = (createdAt: number): string =>
  `New chat ${new Date(createdAt).toISOString().replace('T', ' ').slice(0, 16)}`

/**
 * SessionManager — owns the shared singletons (experiences, skills, knowledge,
 * llm, tools) and spawns an isolated `Agent` per `Session`. Conversation
 * history (ShortTermMemory) is private to each session; everything else is
 * shared. See `docs/design/sub-agent.md#multi-session-concurrency`.
 */
export class SessionManager {
  private deps: SessionManagerDeps
  private sessionsDir: string
  private indexPath: string
  private sessions = new Map<string, Session>()
  private metadataIndex = new Map<string, SessionMetadata>()
  private initialized = false

  // Shared singletons (resolved during init).
  private llm!: LLMProvider
  private tools!: ToolRegistry
  private skills!: SkillRegistry
  private knowledgeStore!: KnowledgeStore
  private experienceStore!: ExperienceStore
  private embedder?: Embedder
  private budgetManager!: BudgetManager
  private cacheMetrics!: CacheMetricsRecorder

  // System-level hook runner + cron scheduler. Hosts process-wide cron hooks
  // (cache-health-alert today; budget daily reset / experience archival in
  // future). Distinct from each Agent's per-session HookRunner so global crons
  // fire exactly once across the whole process, not once per session.
  private systemHooks!: HookRunner
  private systemScheduler!: HookScheduler

  // Channel layer (Phase 3 Batch 5). Outbound + inbound pipe registry.
  // Constructed during `init()`; no concrete channels ship in Phase 3 —
  // Phase 4 will register Feishu/Slack/web implementations here.
  private channels!: ChannelRegistry

  // MCP integration (Phase 4 / B stage). Optional — null when disabled or
  // when no `mcp.json` exists. Owns the lifecycle of every MCP child
  // process and registers `mcp:<server>:<tool>` entries on `this.tools`.
  private mcpManager: MCPManager | null = null

  constructor(deps: SessionManagerDeps) {
    this.deps = deps
    this.sessionsDir = deps.sessionsDir ?? join(deps.dataPath, 'sessions')
    this.indexPath = join(this.sessionsDir, 'index.json')
  }

  /** Initialize shared services and load persisted session metadata. */
  async init(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.sessionsDir, { recursive: true })

    const shared = this.deps.shared ?? {}

    // LLM
    if (shared.llm) {
      this.llm = shared.llm
    } else if (!this.deps.provider) {
      this.llm = LLMProvider.fromEnv()
    } else if (typeof this.deps.provider === 'string') {
      this.llm = LLMProvider.fromPreset(this.deps.provider)
    } else {
      this.llm = new LLMProvider(this.deps.provider)
    }

    // Embedder (optional — used by experience store + knowledge store).
    this.embedder = shared.embedder ?? Embedder.fromProviderConfig(
      this.llm.getProviderType(),
      undefined,
    )

    // Tools
    if (shared.tools) {
      this.tools = shared.tools
    } else {
      this.tools = new ToolRegistry()
      this.tools.register(shellTool)
      this.tools.register(fileReadTool)
      this.tools.register(fileWriteTool)
      this.tools.register(httpTool)
      this.tools.register(browserTool)
    }

    // Skills
    if (shared.skills) {
      this.skills = shared.skills
    } else {
      this.skills = new SkillRegistry(this.deps.dataPath)
      this.skills.register(webSearchSkill)
      this.skills.register(summarizeUrlSkill)
      this.skills.register(selfRepairSkill)
      this.skills.register(githubSkill)
      this.skills.register(codeAnalysisSkill)
      this.skills.register(fileBatchSkill)
      this.skills.register(scheduleSkill)
      this.skills.register(dataExtractSkill)
      await this.skills.init()
    }

    // Experience store
    if (shared.experienceStore) {
      this.experienceStore = shared.experienceStore
    } else {
      this.experienceStore = new ExperienceStore(this.deps.dataPath)
      await this.experienceStore.init()
    }

    // Knowledge store
    if (shared.knowledgeStore) {
      this.knowledgeStore = shared.knowledgeStore
    } else {
      this.knowledgeStore = new KnowledgeStore(this.embedder)
      await this.knowledgeStore.init(this.deps.dataPath)
    }

    // Budget manager — process-wide shared instance. All sessions enforce
    // the same global ceilings and feed the same daily counter.
    if (shared.budgetManager) {
      this.budgetManager = shared.budgetManager
    } else {
      const budgetConfig = await loadBudgetConfig(this.deps.dataPath)
      this.budgetManager = new BudgetManager(budgetConfig, this.deps.dataPath)
      await this.budgetManager.init()
    }

    // Cache metrics recorder — process-wide shared instance. All sessions
    // funnel their per-call cache stats into the same JSONL / daily summary.
    if (shared.cacheMetrics) {
      this.cacheMetrics = shared.cacheMetrics
    } else {
      this.cacheMetrics = new CacheMetricsRecorder(this.deps.dataPath)
      await this.cacheMetrics.init()
    }

    // Observability tools — register now that cacheMetrics + budgetManager
    // exist. These are opt-in to the multi-session runtime: standalone Agent
    // instances that bypass SessionManager will NOT see them. Registered on
    // the shared ToolRegistry so every session inherits them automatically.
    this.tools.register(createMetricsQueryTool(this.cacheMetrics, this.budgetManager))
    this.tools.register(createLogSearchTool(this.experienceStore))
    this.tools.register(createTraceTool(this.experienceStore))

    // System-level hooks — register once across the whole process. The
    // dedicated HookRunner+Scheduler ensures cron hooks fire exactly once
    // (not once per session, which would happen if we registered on each
    // Agent's per-session HookRunner).
    // Channel registry — built before the system hooks so the cache-health
    // alert can broadcast through it. Phase 3 ships empty; Phase 4 will
    // register Feishu/Slack/web channels on this instance.
    this.channels = new ChannelRegistry()

    this.systemHooks = new HookRunner()
    this.systemScheduler = new HookScheduler(this.systemHooks)
    const cacheAlertCfg = this.deps.cacheHealthAlert
    if (cacheAlertCfg?.enabled !== false) {
      // Compose the user-supplied onAlert (if any) with our channel-layer
      // broadcast so alerts fan out to every registered Channel whose
      // capabilities include 'alert.cache-health'. This is the canonical
      // wiring between core hooks and the channel layer.
      const userOnAlert = cacheAlertCfg?.onAlert
      const channels = this.channels
      const mergedOptions: CacheHealthAlertOptions = {
        ...cacheAlertCfg,
        onAlert: async (alert: CacheHealthAlert) => {
          const event: CacheHealthAlertEvent = {
            type: 'alert.cache-health',
            ts: alert.ts,
            hitRatio: alert.hitRatio,
            threshold: alert.threshold,
            totalCalls: alert.totalCalls,
            reason: alert.reason,
          }
          // broadcast() never throws; per-channel failures are logged.
          await channels.broadcast(event)
          if (userOnAlert) {
            try {
              await userOnAlert(alert)
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('[session-manager] user onAlert threw:', err)
            }
          }
        },
      }
      this.systemHooks.register(
        createCacheHealthAlert(this.cacheMetrics, mergedOptions),
      )
    }
    this.systemScheduler.start()

    // MCP integration. Bring up after the shared ToolRegistry exists so
    // mcp:* tools land alongside builtins. Failures are non-blocking by
    // design (see MCPManager.init contract); we still log them upstream.
    if (this.deps.mcp?.enabled !== false) {
      this.mcpManager = new MCPManager({
        dataPath: this.deps.dataPath,
        tools: this.tools,
      })
      try {
        await this.mcpManager.init()
      } catch (err) {
        // MCPManager.init() is supposed to be quiet, but we belt-and-suspenders
        // here so a future bug can never block session startup.
        console.warn('[session-manager] MCPManager init failed:', err)
      }
    }

    // Load persisted session index from disk.
    await this.loadIndex()

    this.initialized = true
  }

  /** Access the live MCPManager (null when disabled or not yet initialized). */
  getMCPManager(): MCPManager | null {
    return this.mcpManager
  }

  /**
   * Reload MCP servers from a fresh list (typically the just-saved
   * `mcp.json`). The web config endpoint calls this after persisting
   * user edits so changes apply without a restart.
   *
   * No-op when MCP is disabled (returns false).
   */
  async reloadMCPServers(
    servers: import('../mcp/types.js').MCPServerConfig[],
  ): Promise<boolean> {
    if (!this.mcpManager) return false
    await this.mcpManager.reload(servers)
    return true
  }

  /** Read the system-level hook runner (system cron hooks live here). */
  getSystemHooks(): HookRunner {
    return this.systemHooks
  }

  /**
   * Access the channel registry (Phase 3 Batch 5). Phase 4 concrete
   * Channel implementations (Feishu, Slack, web, …) register here.
   */
  getChannels(): ChannelRegistry {
    return this.channels
  }

  /** Materialize the shared deps as the type Agent expects. */
  private buildSharedDeps(): AgentSharedDeps {
    return {
      llm: this.llm,
      tools: this.tools,
      skills: this.skills,
      knowledgeStore: this.knowledgeStore,
      experienceStore: this.experienceStore,
      embedder: this.embedder,
      budgetManager: this.budgetManager,
      cacheMetrics: this.cacheMetrics,
    }
  }

  /** Access the shared BudgetManager (for dashboards / admin endpoints). */
  getBudgetManager(): BudgetManager {
    return this.budgetManager
  }

  /** Access the shared CacheMetricsRecorder (for dashboards / cron alert hooks). */
  getCacheMetrics(): CacheMetricsRecorder {
    return this.cacheMetrics
  }

  /** Create a fresh session with its own isolated Agent. */
  async create(input: CreateSessionInput = {}): Promise<Session> {
    if (!this.initialized) {
      throw new Error('SessionManager not initialized — call init() first')
    }

    const now = Date.now()
    const id = input.id ?? nanoid()
    const metadata: SessionMetadata = {
      id,
      title: input.title?.trim() || DEFAULT_TITLE(now),
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
    }

    const agent = new Agent({
      dataPath: this.deps.dataPath,
      shared: this.buildSharedDeps(),
    })
    await agent.init()

    const session = new Session(metadata, agent)
    this.sessions.set(id, session)
    this.metadataIndex.set(id, metadata)
    await this.persistSession(session)
    await this.persistIndex()
    return session
  }

  /**
   * Get a session by id. If the session has metadata on disk but is not yet
   * live in memory, this method will lazily re-hydrate it (re-creating its
   * Agent and loading conversation history) and return it.
   */
  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /**
   * Async variant of `get` that re-hydrates the session from disk if needed.
   * Use this from request handlers where the manager may have been restarted.
   */
  async getOrLoad(id: string): Promise<Session | undefined> {
    const live = this.sessions.get(id)
    if (live) return live

    const metadata = this.metadataIndex.get(id)
    if (!metadata) return undefined

    // Re-hydrate from disk.
    const record = await this.readSessionFile(id)
    const agent = new Agent({
      dataPath: this.deps.dataPath,
      shared: this.buildSharedDeps(),
    })
    await agent.init()

    if (record?.messages?.length) {
      agent.loadHistory(record.messages)
    }
    const session = new Session(metadata, agent)
    this.sessions.set(id, session)
    return session
  }

  /** All known session metadata, sorted by lastActiveAt desc. */
  list(): SessionMetadata[] {
    return [...this.metadataIndex.values()].sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    )
  }

  /** Delete a session and remove its on-disk directory. */
  async delete(id: string): Promise<void> {
    const live = this.sessions.get(id)
    if (live) {
      await live.dispose()
      this.sessions.delete(id)
    }
    this.metadataIndex.delete(id)
    try {
      await rm(this.sessionDir(id), { recursive: true, force: true })
    } catch {
      // Best-effort.
    }
    await this.persistIndex()
  }

  /** Rename a session. */
  async rename(id: string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) return
    const metadata = this.metadataIndex.get(id)
    if (!metadata) return
    metadata.title = trimmed
    metadata.lastActiveAt = Date.now()
    const live = this.sessions.get(id)
    if (live) {
      live.metadata.title = trimmed
      live.metadata.lastActiveAt = metadata.lastActiveAt
      await this.persistSession(live)
    }
    await this.persistIndex()
  }

  /**
   * Persist a live session's conversation history to disk. Call this after
   * each completed message turn so on-restart resume works.
   */
  async persistSession(session: Session): Promise<void> {
    const record: PersistedSessionRecord = {
      metadata: session.getMetadata(),
      messages: session.getMessages(),
      summary: session.agent.getMemoryManager().shortTerm.getSummary(),
    }
    await mkdir(this.sessionDir(session.metadata.id), { recursive: true })
    await writeFile(
      this.sessionFile(session.metadata.id),
      JSON.stringify(record, null, 2),
      'utf-8',
    )
    // Keep the in-memory metadata snapshot fresh.
    this.metadataIndex.set(session.metadata.id, session.getMetadata())
  }

  /** Dispose all live sessions. Persist nothing extra here — caller may have already. */
  async shutdown(): Promise<void> {
    try {
      this.systemScheduler?.stop()
    } catch {
      // Best-effort.
    }
    for (const session of this.sessions.values()) {
      try {
        await session.dispose()
      } catch {
        // Continue disposing the rest.
      }
    }
    this.sessions.clear()
    try {
      await this.mcpManager?.shutdown()
    } catch {
      // Best-effort — child processes will be reaped on parent exit anyway.
    }
    this.mcpManager = null
    try {
      await this.budgetManager?.shutdown()
    } catch {
      // Best-effort.
    }
    try {
      await this.cacheMetrics?.shutdown()
    } catch {
      // Best-effort.
    }
  }

  // ============================================================
  // Persistence helpers
  // ============================================================

  private sessionDir(id: string): string {
    return join(this.sessionsDir, id)
  }

  private sessionFile(id: string): string {
    return join(this.sessionDir(id), 'short-term.json')
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await readFile(this.indexPath, 'utf-8')
      const list = JSON.parse(raw) as SessionMetadata[]
      for (const meta of list) {
        this.metadataIndex.set(meta.id, meta)
      }
    } catch {
      // No index yet — fresh install.
    }
  }

  private async persistIndex(): Promise<void> {
    const list = [...this.metadataIndex.values()].sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    )
    await writeFile(this.indexPath, JSON.stringify(list, null, 2), 'utf-8')
  }

  private async readSessionFile(id: string): Promise<PersistedSessionRecord | undefined> {
    try {
      const raw = await readFile(this.sessionFile(id), 'utf-8')
      return JSON.parse(raw) as PersistedSessionRecord
    } catch {
      return undefined
    }
  }
}
