import { z } from 'zod'
import { type LLMProvider, type GenerateResult } from '../llm/provider.js'
import type { Experience, Plan, PromptConfig } from '../types.js'
import type { SkillRegistry } from '../skills/skill-registry.js'
import type { CapabilityMap } from '../agent/capability-map.js'
import type { PromptRegistry } from '../prompts/registry.js'
import type { SubAgentRegistry } from '../sub-agents/loader.js'
import {
  buildRouterToolSet,
  ROUTER_SYSTEM_PROMPT_PREFIX,
} from '../sub-agents/router-tool.js'
import { nanoid } from 'nanoid'

/**
 * Baseline (source-code) prompt. Phase 4 C introduced `PromptRegistry` which
 * can override this at runtime via `data/prompts/active.json`. This constant
 * remains the authoritative fallback when no override is present — do NOT
 * mutate it at runtime.
 */
export const PLANNER_SYSTEM_PROMPT = `You are a task planner for an AI Agent system. Your job is to decompose user tasks into executable steps.

Each step should specify:
- A clear description of what to do
- Which tool or skill to use (if any)
- The parameters for that tool/skill

Available tools (low-level):
- shell: Run shell commands. params: { command: string }
- file_read: Read files. params: { path: string }
- file_write: Write files. params: { path: string, content: string }
- http: HTTP requests. params: { method: string, url: string, body?: string, headers?: object }
- browser: Control headless browser. params: { action: string, url?: string, selector?: string, text?: string, script?: string }

{SKILLS_SECTION}

{CAPABILITIES_SECTION}

Respond with a JSON object:
{
  "task": "summary of the task",
  "steps": [
    {
      "description": "what this step does",
      "tool": "tool_name or skill:<id> or null if no tool needed",
      "params": { ... }
    }
  ]
}

IMPORTANT:
- Prefer skills over raw tools when a matching skill exists — skills handle complex multi-step workflows automatically.
- For example, use "skill:web-search" instead of manually composing browser goto + text extraction steps.
- If the user pastes a URL or asks about "this page / this site / this article", ALWAYS plan a tool step — use "skill:summarize-url" for content extraction, or "browser" with action "goto" FOLLOWED BY action "text" to actually read the body. A bare "goto" only returns the title — almost never enough. When calling "browser" action "text", DO NOT pass a "selector" parameter — let it return the full body. Only specify a selector if a prior tool call in this same plan has already proven that selector exists; never invent CSS selectors based on what you imagine the page structure looks like. Do not answer conversationally about URLs you have not fetched.
- If the user asks about REAL-TIME or SYSTEM STATE — current time / date, working directory, OS / hostname, environment variables, file existence, network reachability, running processes, disk usage, git status, etc. — you MUST plan a "shell" tool step (e.g. \`date\`, \`pwd\`, \`uname -a\`, \`ls\`, \`git status\`). The LLM has no access to a real clock or filesystem; answering from memory will be wrong.
- "Simple conversation" means greetings, opinion questions, knowledge the LLM already has. Anything that requires fresh facts from the outside world (web, clock, filesystem, network) is NOT simple — it needs a tool.
- If the task is a genuine simple conversation that doesn't require tools, return an empty steps array.
- Keep plans concise — prefer fewer, well-defined steps over many small ones.
- Only use tools and skills that are listed as available. If the task requires capabilities you don't have, say so honestly instead of trying to use unavailable tools.`

const planSchema = z.object({
  task: z.string(),
  steps: z.array(
    z.object({
      description: z.string(),
      tool: z.string().optional(),
      params: z.record(z.unknown()).optional(),
    }),
  ),
})

export interface PlannerOptions {
  /**
   * Phase 5 — when true, the planner bypasses the JSON-plan prompt entirely
   * and instead asks the LLM to pick exactly one sub-agent via a single
   * `delegate` function-calling tool. Requires `subAgentRegistry` to also
   * be supplied; if the registry is missing or empty, router mode falls
   * back to legacy solo behavior silently.
   */
  routerMode?: boolean
  /** Sub-agent registry, used to build the router tool's enum + catalog. */
  subAgentRegistry?: SubAgentRegistry
}

export class Planner {
  private routerMode: boolean
  private subAgentRegistry?: SubAgentRegistry

  constructor(
    private llm: LLMProvider,
    private skills?: SkillRegistry,
    private capabilityMap?: CapabilityMap,
    private promptRegistry?: PromptRegistry,
    options: PlannerOptions = {},
  ) {
    this.routerMode = !!options.routerMode
    this.subAgentRegistry = options.subAgentRegistry
  }

  async plan(
    userMessage: string,
    relatedExperiences: Experience[],
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<{ plan: Plan; metrics: GenerateResult['metrics'] }> {
    // Phase 5 router mode — replaces the JSON-plan pipeline with a single
    // function-calling step that picks one specialist sub-agent.
    if (this.routerMode && this.subAgentRegistry && this.subAgentRegistry.list().length > 0) {
      return this.planRouterMode(userMessage, relatedExperiences, history)
    }
    // Build system prompt with available skills and capabilities
    const skillsSection = this.skills
      ? this.skills.describeForPlanner()
      : ''
    const capabilitiesSection = this.capabilityMap
      ? this.capabilityMap.describeForPlanner()
      : ''
    const template = this.promptRegistry?.get('planner') ?? PLANNER_SYSTEM_PROMPT
    const systemPrompt = template
      .replace('{SKILLS_SECTION}', skillsSection)
      .replace('{CAPABILITIES_SECTION}', capabilitiesSection)

    const config: PromptConfig = {
      systemPrompt,
      skills: [],
      history,
      experiences: relatedExperiences,
      currentInput: userMessage,
      provider: this.llm.getProviderType(),
    }

    const messages = this.llm.buildMessages(config)
    const result = await this.llm.generate('planner', messages)

    // Parse the plan from LLM response
    let plan: Plan
    try {
      // Try to extract JSON from the response (may have markdown code blocks)
      let jsonText = result.text
      const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (jsonMatch) jsonText = jsonMatch[1]

      const parsed = planSchema.parse(JSON.parse(jsonText))
      plan = {
        task: parsed.task,
        steps: parsed.steps.map((s) => ({
          id: nanoid(8),
          description: s.description,
          tool: s.tool,
          params: s.params,
        })),
        relatedExperiences,
      }
    } catch {
      // If parsing fails, treat as a conversational response (no tool steps)
      plan = {
        task: userMessage,
        steps: [],
        relatedExperiences,
      }
    }

    // Validate plan steps against available capabilities
    if (this.capabilityMap && plan.steps.length > 0) {
      const available = new Set(
        this.capabilityMap
          .list()
          .filter((c) => c.confidence > 0)
          .flatMap((c) => [...c.tools, ...c.skills.map((s) => `skill:${s}`)]),
      )

      for (const step of plan.steps) {
        if (!step.tool) continue
        if (!available.has(step.tool)) {
          // Mark the step description with a warning so the executor
          // and the user can see this step may fail.
          step.description = `[WARNING: tool "${step.tool}" may not be available] ${step.description}`
        }
      }
    }

    return { plan, metrics: result.metrics }
  }

  // ------------------------------------------------------------
  // Phase 5 — router mode
  // ------------------------------------------------------------

  private async planRouterMode(
    userMessage: string,
    relatedExperiences: Experience[],
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<{ plan: Plan; metrics: GenerateResult['metrics'] }> {
    const registry = this.subAgentRegistry!
    const tools = buildRouterToolSet(registry)

    const config: PromptConfig = {
      systemPrompt: ROUTER_SYSTEM_PROMPT_PREFIX,
      skills: [],
      history,
      experiences: relatedExperiences,
      currentInput: userMessage,
      provider: this.llm.getProviderType(),
    }
    const messages = this.llm.buildMessages(config)

    // Call the LLM with the delegate tool available. Any parse / provider
    // failure falls through to the research-default fallback below — the
    // inverted :122-128 fallback required by the §3.0.5 spec.
    let result: GenerateResult | undefined
    let callError: unknown
    try {
      result = await this.llm.generate('planner', messages, tools)
    } catch (err) {
      callError = err
    }

    if (!result) {
      return {
        plan: this.buildResearchFallbackPlan(userMessage, relatedExperiences, callError),
        // Router-mode fallback: we never got metrics because the LLM call
        // threw. Surface a zero-shaped metrics stub so downstream tracking
        // doesn't crash. The catch path is a last-resort defense for a
        // failure that should have been rare.
        metrics: this.emptyMetricsStub(),
      }
    }

    // Tolerate two tool-call shapes observed from openai-compatible
    // providers:
    //
    //   1. The "correct" shape: toolName === 'delegate', args contains
    //      { subagent_type, task, rationale }. This is what Anthropic +
    //      the ai SDK + qwen3-coder-plus-with-3-enum-values all return.
    //
    //   2. The bailian/qwen-coder quirk with 2 enum values: the SDK
    //      surfaces toolName as the *enum value itself* (e.g. 'system'
    //      or 'research'), and the args block STILL carries a
    //      `subagent_type` field. Empirically observed on
    //      qwen3-coder-plus via the openai-compatible endpoint. We
    //      treat any tool call whose name matches a registered
    //      sub-agent as an implicit delegate to that sub-agent.
    //
    // Whichever shape arrives, we derive the target from args first and
    // fall back to toolName, then validate against the registry.
    const toolCalls = result.toolCalls ?? []
    const delegateCall =
      toolCalls.find((tc) => tc.toolName === 'delegate') ??
      toolCalls.find((tc) => registry.get(tc.toolName) !== undefined)

    if (delegateCall) {
      const args = delegateCall.args as {
        subagent_type?: unknown
        task?: unknown
        rationale?: unknown
      }
      const subagentTypeFromArgs =
        typeof args.subagent_type === 'string' ? args.subagent_type : ''
      // Prefer the explicit args field, but fall back to the tool name
      // when the provider quirk flattened the enum value into it.
      const subagentType =
        subagentTypeFromArgs ||
        (registry.get(delegateCall.toolName) ? delegateCall.toolName : '')
      const task = typeof args.task === 'string' ? args.task : userMessage
      const rationale =
        typeof args.rationale === 'string' && args.rationale.trim().length > 0
          ? args.rationale
          : 'Router chose this specialist'

      // Validate against the registry; if the model hallucinated a name
      // (shouldn't happen because it's enum-typed) fall back to research.
      const def = registry.get(subagentType)
      if (!def) {
        return {
          plan: this.buildResearchFallbackPlan(
            userMessage,
            relatedExperiences,
            new Error(`Router picked unknown subagent_type "${subagentType}"`),
          ),
          metrics: result.metrics,
        }
      }

      const plan: Plan = {
        task: userMessage,
        steps: [
          {
            id: nanoid(8),
            description: `Delegate to ${subagentType}: ${rationale}`,
            tool: 'delegate',
            params: {
              subagent_type: subagentType,
              task,
              rationale,
            },
          },
        ],
        relatedExperiences,
      }
      return { plan, metrics: result.metrics }
    }

    // DIRECT mode — the router chose not to delegate. If the LLM actually
    // produced some text, hand control to the existing conversational
    // branch by returning an empty-steps Plan. Otherwise we fall through
    // to the inverted catch fallback.
    if ((result.text ?? '').trim().length > 0) {
      return {
        plan: {
          task: userMessage,
          steps: [],
          relatedExperiences,
        },
        metrics: result.metrics,
      }
    }

    // Inverted :122-128 fallback — parse / empty-reply failure defaults
    // to `delegate research` rather than a silent empty plan that would
    // then be hallucinated over by the conversational branch.
    return {
      plan: this.buildResearchFallbackPlan(userMessage, relatedExperiences, null),
      metrics: result.metrics,
    }
  }

  private buildResearchFallbackPlan(
    userMessage: string,
    relatedExperiences: Experience[],
    _reason: unknown,
  ): Plan {
    return {
      task: userMessage,
      steps: [
        {
          id: nanoid(8),
          description: 'Router parse failure — defaulting to research',
          tool: 'delegate',
          params: {
            subagent_type: 'research',
            task: userMessage,
            rationale:
              'Router could not classify the request; falling back to research.',
          },
        },
      ],
      relatedExperiences,
    }
  }

  private emptyMetricsStub(): GenerateResult['metrics'] {
    // Sentinel model id — grep-friendly so operators can filter these
    // zero-cost rows out of cost dashboards without mistaking them for
    // real model calls. Prefixed with provider type so filters can
    // scope by provider.
    return {
      callId: nanoid(8),
      model: `${this.llm.getProviderType()}:router-fallback-error`,
      provider: this.llm.getProviderType(),
      timestamp: new Date().toISOString(),
      tokens: { prompt: 0, completion: 0, cacheWrite: 0, cacheRead: 0 },
      cacheHitRate: 0,
      cost: 0,
      savedCost: 0,
      duration: 0,
    }
  }
}
