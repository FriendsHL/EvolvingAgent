import { generateText, streamText, type CoreMessage, type ToolSet } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import type { Experience, LLMCallMetrics, PromptConfig, Skill, ToolDefinition } from '../types.js'
import { nanoid } from 'nanoid'

// === Model Configuration ===

const MODELS = {
  planner: anthropic('claude-sonnet-4-20250514'),
  executor: anthropic('claude-sonnet-4-20250514'),
  reflector: anthropic('claude-haiku-4-5-20251001'),
} as const

export type ModelRole = keyof typeof MODELS

// === Prompt Builder: 4-Layer Cache Structure ===

function withAnthropicCache(message: CoreMessage): CoreMessage {
  return {
    ...message,
    providerMetadata: {
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

export function buildMessages(config: PromptConfig): CoreMessage[] {
  const messages: CoreMessage[] = []

  // Layer 1: System prompt (most stable — cache breakpoint 1)
  messages.push(
    withAnthropicCache({
      role: 'system' as const,
      content: config.systemPrompt,
    }),
  )

  // Layer 2: Skills + Knowledge (fairly stable — cache breakpoint 2)
  if (config.skills.length > 0 || config.knowledge.length > 0) {
    messages.push(
      withAnthropicCache({
        role: 'user' as const,
        content: formatSkillsAndKnowledge(config.skills, config.knowledge),
      }),
    )
    messages.push({ role: 'assistant' as const, content: 'Understood.' })
  }

  // Layer 3: Conversation history (moderate change — cache breakpoint 3)
  if (config.history.length > 0) {
    const history = config.history.map((h) => ({
      role: h.role as 'user' | 'assistant',
      content: h.content,
    }))
    // Mark last history message for cache
    history[history.length - 1] = withAnthropicCache(history[history.length - 1]) as typeof history[number]
    messages.push(...history)
  }

  // Layer 4: Current input + retrieved experiences (no cache)
  const experienceBlock = formatExperiences(config.experiences)
  const currentContent = [experienceBlock, config.currentInput].filter(Boolean).join('\n\n')
  messages.push({ role: 'user' as const, content: currentContent })

  return messages
}

// Sort tools alphabetically for stable prompt cache
export function buildToolSet(tools: ToolDefinition[]): Record<string, { description: string; parameters: Record<string, unknown> }> {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name))
  return Object.fromEntries(
    sorted.map((t) => [t.name, { description: t.description, parameters: t.parameters }]),
  )
}

// === LLM Call Wrappers ===

function extractCacheMetrics(result: { providerMetadata?: Record<string, unknown> }): {
  cacheRead: number
  cacheWrite: number
} {
  const meta = result.providerMetadata?.anthropic as Record<string, number> | undefined
  return {
    cacheRead: meta?.cacheReadInputTokens ?? 0,
    cacheWrite: meta?.cacheCreationInputTokens ?? 0,
  }
}

function computeCost(model: string, tokens: LLMCallMetrics['tokens']): { cost: number; savedCost: number } {
  // Anthropic Sonnet pricing (per million tokens)
  const isSonnet = model.includes('sonnet')
  const inputPrice = isSonnet ? 3.0 : 1.0 // Haiku = $1/M
  const outputPrice = isSonnet ? 15.0 : 5.0
  const cacheWritePrice = inputPrice * 1.25
  const cacheReadPrice = inputPrice * 0.1

  const normalInputTokens = tokens.prompt - tokens.cacheRead - tokens.cacheWrite
  const cost =
    (normalInputTokens * inputPrice +
      tokens.cacheWrite * cacheWritePrice +
      tokens.cacheRead * cacheReadPrice +
      tokens.completion * outputPrice) /
    1_000_000

  // What it would have cost without cache
  const noCacheCost = ((tokens.prompt + tokens.cacheRead + tokens.cacheWrite) * inputPrice + tokens.completion * outputPrice) / 1_000_000
  const savedCost = noCacheCost - cost

  return { cost: Math.max(0, cost), savedCost: Math.max(0, savedCost) }
}

export interface GenerateResult {
  text: string
  toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>
  metrics: LLMCallMetrics
}

export async function generateWithTools(
  role: ModelRole,
  messages: CoreMessage[],
  tools?: ToolSet,
): Promise<GenerateResult> {
  const model = MODELS[role]
  const startTime = Date.now()

  const result = await generateText({
    model,
    messages,
    tools,
    maxSteps: 1,
  })

  const cache = extractCacheMetrics(result)
  const tokens = {
    prompt: result.usage?.promptTokens ?? 0,
    completion: result.usage?.completionTokens ?? 0,
    cacheWrite: cache.cacheWrite,
    cacheRead: cache.cacheRead,
  }
  const totalInput = tokens.prompt + tokens.cacheRead + tokens.cacheWrite
  const cacheHitRate = totalInput > 0 ? tokens.cacheRead / totalInput : 0
  const { cost, savedCost } = computeCost(model.modelId, tokens)

  const metrics: LLMCallMetrics = {
    callId: nanoid(),
    model: model.modelId,
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
      args: tc.args as Record<string, unknown>,
    })) ?? [],
    metrics,
  }
}

export async function* streamWithTools(
  role: ModelRole,
  messages: CoreMessage[],
  tools?: ToolSet,
): AsyncGenerator<{ type: 'text-delta'; text: string } | { type: 'finish'; metrics: LLMCallMetrics }> {
  const model = MODELS[role]
  const startTime = Date.now()

  const result = streamText({
    model,
    messages,
    tools,
    maxSteps: 1,
  })

  for await (const chunk of result.textStream) {
    yield { type: 'text-delta', text: chunk }
  }

  const finalResult = await result
  const cache = extractCacheMetrics(finalResult)
  const tokens = {
    prompt: finalResult.usage?.promptTokens ?? 0,
    completion: finalResult.usage?.completionTokens ?? 0,
    cacheWrite: cache.cacheWrite,
    cacheRead: cache.cacheRead,
  }
  const totalInput = tokens.prompt + tokens.cacheRead + tokens.cacheWrite
  const cacheHitRate = totalInput > 0 ? tokens.cacheRead / totalInput : 0
  const { cost, savedCost } = computeCost(model.modelId, tokens)

  yield {
    type: 'finish',
    metrics: {
      callId: nanoid(),
      model: model.modelId,
      timestamp: new Date().toISOString(),
      tokens,
      cacheHitRate,
      cost,
      savedCost,
      duration: Date.now() - startTime,
    },
  }
}
