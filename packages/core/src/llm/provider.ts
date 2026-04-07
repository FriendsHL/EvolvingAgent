import { generateText, streamText, type ModelMessage, type ToolSet } from 'ai'

// generateText accepts LanguageModelV1 but providers may return V3.
// Both work at runtime — store as the union type generateText expects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = any
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { Experience, LLMCallMetrics, PromptConfig, Skill, ToolDefinition } from '../types.js'
import { extractCacheTokens } from '../metrics/extract-cache-tokens.js'
import { nanoid } from 'nanoid'

// ============================================================
// Provider Configuration
// ============================================================

export type ProviderType = 'anthropic' | 'openai' | 'openai-compatible'

export interface ProviderConfig {
  type: ProviderType
  apiKey?: string       // Falls back to env: ANTHROPIC_API_KEY / OPENAI_API_KEY / DASHSCOPE_API_KEY
  baseURL?: string      // Required for openai-compatible (e.g. 百炼: https://dashscope.aliyuncs.com/compatible-mode/v1)
  models: {
    planner: string     // Model ID for planning
    executor: string    // Model ID for execution
    reflector: string   // Model ID for reflection (cost-efficient)
  }
}

// === Preset Configurations ===

export const PROVIDER_PRESETS = {
  anthropic: {
    type: 'anthropic' as const,
    models: {
      planner: 'claude-sonnet-4-20250514',
      executor: 'claude-sonnet-4-20250514',
      reflector: 'claude-haiku-4-5-20251001',
    },
  },
  openai: {
    type: 'openai' as const,
    models: {
      planner: 'gpt-4o',
      executor: 'gpt-4o',
      reflector: 'gpt-4o-mini',
    },
  },
  bailian: {
    type: 'openai-compatible' as const,
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: {
      planner: 'qwen-plus',
      executor: 'qwen-plus',
      reflector: 'qwen-turbo',
    },
  },
  'bailian-coding': {
    type: 'openai-compatible' as const,
    baseURL: 'https://coding.dashscope.aliyuncs.com/v1',
    models: {
      planner: 'qwen3-coder-plus',
      executor: 'qwen3-coder-plus',
      reflector: 'glm-5',
    },
  },
  'bailian-glm5': {
    type: 'openai-compatible' as const,
    baseURL: 'https://coding.dashscope.aliyuncs.com/v1',
    models: {
      planner: 'glm-5',
      executor: 'glm-5',
      reflector: 'glm-5',
    },
  },
  deepseek: {
    type: 'openai-compatible' as const,
    baseURL: 'https://api.deepseek.com',
    models: {
      planner: 'deepseek-chat',
      executor: 'deepseek-chat',
      reflector: 'deepseek-chat',
    },
  },
} satisfies Record<string, ProviderConfig>

export type PresetName = keyof typeof PROVIDER_PRESETS

// ============================================================
// LLM Provider — multi-backend
// ============================================================

export type ModelRole = 'planner' | 'executor' | 'reflector'

/**
 * Optional per-call options for `LLMProvider.generate` / `stream`.
 *
 * Currently used by the budget-guard hook to force a downgrade target model
 * when a sub-agent task crosses its budget. Future call sites may extend
 * this without breaking existing callers.
 */
export interface LLMCallOptions {
  /**
   * Per-call model id override. When set, bypasses the role-to-model
   * mapping (`config.models[role]`) and uses this specific model id for
   * exactly this call. Used by the budget-guard downgrade path.
   */
  modelOverride?: string
}

export class LLMProvider {
  private config: ProviderConfig
  private models: Record<ModelRole, AnyModel>

  constructor(config: ProviderConfig) {
    this.config = config
    this.models = this.createModels(config)
  }

  /** Create from preset name (e.g. 'anthropic', 'bailian', 'deepseek') */
  static fromPreset(name: PresetName, overrides?: Partial<ProviderConfig>): LLMProvider {
    const preset = PROVIDER_PRESETS[name]
    return new LLMProvider({ ...preset, ...overrides })
  }

  /** Create from environment variables */
  static fromEnv(): LLMProvider {
    // Auto-detect provider from env
    const providerType = process.env.EVOLVING_AGENT_PROVIDER as PresetName | undefined
    if (providerType && providerType in PROVIDER_PRESETS) {
      return LLMProvider.fromPreset(providerType)
    }

    // Check which API key is set
    if (process.env.DASHSCOPE_API_KEY) {
      return LLMProvider.fromPreset('bailian')
    }
    if (process.env.OPENAI_API_KEY) {
      return LLMProvider.fromPreset('openai')
    }
    // Default to Anthropic
    return LLMProvider.fromPreset('anthropic')
  }

  private createModelInstance(modelId: string): AnyModel {
    const config = this.config
    switch (config.type) {
      case 'anthropic': {
        const provider = createAnthropic({ apiKey: config.apiKey })
        return provider(modelId)
      }
      case 'openai': {
        const provider = createOpenAI({ apiKey: config.apiKey })
        // Use chat() for Chat Completions API (broader compatibility)
        return provider.chat(modelId)
      }
      case 'openai-compatible': {
        const provider = createOpenAI({
          apiKey: config.apiKey ?? process.env.DASHSCOPE_API_KEY,
          baseURL: config.baseURL,
        })
        // Must use chat() — compatible endpoints don't support Responses API
        return provider.chat(modelId)
      }
    }
  }

  private createModels(config: ProviderConfig): Record<ModelRole, AnyModel> {
    return {
      planner: this.createModelInstance(config.models.planner),
      executor: this.createModelInstance(config.models.executor),
      reflector: this.createModelInstance(config.models.reflector),
    }
  }

  /**
   * Resolve the (model instance, model id) tuple for a call. Honors an
   * optional per-call override; otherwise falls back to the role mapping.
   * Override-built models are constructed on the fly (not cached) — the
   * downgrade path is rare enough not to warrant a cache.
   */
  private resolveModel(role: ModelRole, override: string | undefined): { model: AnyModel; modelId: string } {
    if (override && override !== this.config.models[role]) {
      return { model: this.createModelInstance(override), modelId: override }
    }
    return { model: this.models[role], modelId: this.config.models[role] }
  }

  getModel(role: ModelRole): AnyModel {
    return this.models[role]
  }

  getProviderType(): ProviderType {
    return this.config.type
  }

  getModelId(role: ModelRole): string {
    return this.config.models[role]
  }

  // ============================================================
  // Prompt Builder: 4-Layer Cache Structure
  // ============================================================

  buildMessages(config: PromptConfig): ModelMessage[] {
    const messages: ModelMessage[] = []
    const useAnthropicCache = this.config.type === 'anthropic'

    // Layer 1: System prompt (most stable — cache breakpoint 1)
    const systemMsg: ModelMessage = { role: 'system' as const, content: config.systemPrompt }
    messages.push(useAnthropicCache ? withAnthropicCache(systemMsg) : systemMsg)

    // Layer 2: Skills + Knowledge (fairly stable — cache breakpoint 2)
    if (config.skills.length > 0 || config.knowledge.length > 0) {
      const skillMsg: ModelMessage = {
        role: 'user' as const,
        content: formatSkillsAndKnowledge(config.skills, config.knowledge),
      }
      messages.push(useAnthropicCache ? withAnthropicCache(skillMsg) : skillMsg)
      messages.push({ role: 'assistant' as const, content: 'Understood.' })
    }

    // Layer 3: Conversation history (moderate change — cache breakpoint 3)
    if (config.history.length > 0) {
      const history = config.history.map((h) => ({
        role: h.role as 'user' | 'assistant',
        content: h.content,
      }))
      if (useAnthropicCache) {
        history[history.length - 1] = withAnthropicCache(history[history.length - 1]) as typeof history[number]
      }
      messages.push(...history)
    }

    // Layer 4: Current input + retrieved experiences (no cache)
    const experienceBlock = formatExperiences(config.experiences)
    const currentContent = [experienceBlock, config.currentInput].filter(Boolean).join('\n\n')
    messages.push({ role: 'user' as const, content: currentContent })

    return messages
  }

  // ============================================================
  // LLM Call Wrappers
  // ============================================================

  async generate(
    role: ModelRole,
    messages: ModelMessage[],
    tools?: ToolSet,
    options?: LLMCallOptions,
  ): Promise<GenerateResult> {
    const { model, modelId: resolvedModelId } = this.resolveModel(role, options?.modelOverride)
    const startTime = Date.now()

    const result = await generateText({
      model,
      messages,
      tools,
    })

    const usage = result.usage
    // Ask the provider-agnostic extractor for cache tokens. It prefers the
    // normalized usage and falls back to raw providerMetadata for each
    // provider. Keeps us working even if the SDK's normalization misses an
    // edge case (e.g. OpenAI-compatible endpoints via 百炼/deepseek).
    const extracted = extractCacheTokens(
      result.providerMetadata as Record<string, unknown> | undefined,
      this.config.type,
      usage,
    )
    const tokens = {
      prompt: usage?.inputTokens ?? 0,
      completion: usage?.outputTokens ?? 0,
      cacheWrite: extracted.cacheCreationTokens,
      cacheRead: extracted.cacheReadTokens,
    }
    const totalInput = tokens.prompt + tokens.cacheRead + tokens.cacheWrite
    const cacheHitRate = totalInput > 0 ? tokens.cacheRead / totalInput : 0
    const modelId = resolvedModelId
    const { cost, savedCost } = computeCost(modelId, this.config.type, tokens)

    const metrics: LLMCallMetrics = {
      callId: nanoid(),
      model: modelId,
      provider: this.config.type,
      timestamp: new Date().toISOString(),
      tokens,
      cacheHitRate,
      cost,
      savedCost,
      duration: Date.now() - startTime,
    }

    return {
      text: result.text,
      toolCalls: result.toolCalls?.map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.input as Record<string, unknown>,
      })) ?? [],
      metrics,
    }
  }

  async *stream(
    role: ModelRole,
    messages: ModelMessage[],
    tools?: ToolSet,
    options?: LLMCallOptions,
  ): AsyncGenerator<{ type: 'text-delta'; text: string } | { type: 'finish'; metrics: LLMCallMetrics }> {
    const { model, modelId: resolvedModelId } = this.resolveModel(role, options?.modelOverride)
    const startTime = Date.now()

    const result = streamText({
      model,
      messages,
      tools,
    })

    for await (const chunk of result.textStream) {
      yield { type: 'text-delta', text: chunk }
    }

    const usage = await result.usage
    let providerMetadata: Record<string, unknown> | undefined
    try {
      const pm = await (result as unknown as { providerMetadata?: PromiseLike<unknown> }).providerMetadata
      providerMetadata = pm as Record<string, unknown> | undefined
    } catch {
      providerMetadata = undefined
    }
    const extracted = extractCacheTokens(providerMetadata, this.config.type, usage)
    const tokens = {
      prompt: usage?.inputTokens ?? 0,
      completion: usage?.outputTokens ?? 0,
      cacheWrite: extracted.cacheCreationTokens,
      cacheRead: extracted.cacheReadTokens,
    }
    const totalInput = tokens.prompt + tokens.cacheRead + tokens.cacheWrite
    const cacheHitRate = totalInput > 0 ? tokens.cacheRead / totalInput : 0
    const modelId = resolvedModelId
    const { cost, savedCost } = computeCost(modelId, this.config.type, tokens)

    yield {
      type: 'finish',
      metrics: {
        callId: nanoid(),
        model: modelId,
        provider: this.config.type,
        timestamp: new Date().toISOString(),
        tokens,
        cacheHitRate,
        cost,
        savedCost,
        duration: Date.now() - startTime,
      },
    }
  }
}

// ============================================================
// Helpers
// ============================================================

export interface GenerateResult {
  text: string
  toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>
  metrics: LLMCallMetrics
}

function withAnthropicCache(message: ModelMessage): ModelMessage {
  return {
    ...message,
    providerOptions: {
      anthropic: { cacheControl: { type: 'ephemeral' as const } },
    },
  }
}

function formatExperiences(experiences: Experience[]): string {
  if (experiences.length === 0) return ''
  const lines = experiences.map((exp) => {
    const status = exp.result === 'success' ? 'OK' : exp.result === 'partial' ? 'PARTIAL' : 'FAIL'
    return `[${status}] ${exp.task}\n  Lesson: ${exp.reflection.lesson}\n  Tags: ${exp.tags.join(', ')}`
  })
  return `## Related Experiences\n\n${lines.join('\n\n')}`
}

function formatSkillsAndKnowledge(skills: Skill[], knowledge: string[]): string {
  const parts: string[] = []
  if (skills.length > 0) {
    const skillList = skills
      .map((s) => `- **${s.name}** (score: ${s.score.toFixed(2)}, used ${s.usageCount}x): ${s.trigger}`)
      .join('\n')
    parts.push(`## Available Skills\n\n${skillList}`)
  }
  if (knowledge.length > 0) {
    parts.push(`## Knowledge\n\n${knowledge.join('\n\n')}`)
  }
  return parts.join('\n\n')
}

// Sort tools alphabetically for stable prompt cache
export function buildToolSet(tools: ToolDefinition[]): Record<string, { description: string; parameters: Record<string, unknown> }> {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name))
  return Object.fromEntries(
    sorted.map((t) => [t.name, { description: t.description, parameters: t.parameters }]),
  )
}

// === Cost Estimation ===
// Approximate pricing per million tokens — used for observability, not billing

const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  // Qwen (百炼)
  'qwen-plus': { input: 0.8, output: 2 },
  'qwen-turbo': { input: 0.3, output: 0.6 },
  'qwen-max': { input: 2.4, output: 9.6 },
  'qwen-coder-plus': { input: 3.5, output: 7 },
  // DeepSeek
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
}

const DEFAULT_PRICING = { input: 1, output: 5 }

function computeCost(
  modelId: string,
  providerType: ProviderType,
  tokens: LLMCallMetrics['tokens'],
): { cost: number; savedCost: number } {
  const pricing = PRICING[modelId] ?? DEFAULT_PRICING

  const isAnthropic = providerType === 'anthropic'
  const cacheWritePrice = isAnthropic ? pricing.input * 1.25 : 0
  const cacheReadPrice = isAnthropic ? pricing.input * 0.1 : pricing.input * 0.5

  const normalInputTokens = tokens.prompt - tokens.cacheRead - tokens.cacheWrite
  const cost =
    (Math.max(0, normalInputTokens) * pricing.input +
      tokens.cacheWrite * cacheWritePrice +
      tokens.cacheRead * cacheReadPrice +
      tokens.completion * pricing.output) /
    1_000_000

  // What it would have cost without cache
  const totalInputTokens = tokens.prompt + tokens.cacheRead + tokens.cacheWrite
  const noCacheCost = (totalInputTokens * pricing.input + tokens.completion * pricing.output) / 1_000_000
  const savedCost = noCacheCost - cost

  return { cost: Math.max(0, cost), savedCost: Math.max(0, savedCost) }
}

// ============================================================
// Backward-compatible free functions (delegate to a default instance)
// ============================================================

let _defaultProvider: LLMProvider | undefined

export function getDefaultProvider(): LLMProvider {
  if (!_defaultProvider) {
    _defaultProvider = LLMProvider.fromEnv()
  }
  return _defaultProvider
}

export function setDefaultProvider(provider: LLMProvider): void {
  _defaultProvider = provider
}

/** @deprecated Use LLMProvider instance methods. Kept for backward compat. */
export function buildMessages(config: PromptConfig): ModelMessage[] {
  return getDefaultProvider().buildMessages(config)
}

/** @deprecated Use provider.generate(). Kept for backward compat. */
export async function generateWithTools(
  role: ModelRole,
  messages: ModelMessage[],
  tools?: ToolSet,
): Promise<GenerateResult> {
  return getDefaultProvider().generate(role, messages, tools)
}

/** @deprecated Use provider.stream(). Kept for backward compat. */
export async function* streamWithTools(
  role: ModelRole,
  messages: ModelMessage[],
  tools?: ToolSet,
): AsyncGenerator<{ type: 'text-delta'; text: string } | { type: 'finish'; metrics: LLMCallMetrics }> {
  yield* getDefaultProvider().stream(role, messages, tools)
}
