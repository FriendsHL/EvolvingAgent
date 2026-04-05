// ============================================================
// Capability Boundary Awareness — M7
//
// Builds a map of what the agent can and cannot do based on
// currently registered tools and skills. Used by the Planner
// to give honest answers when a task is infeasible.
// ============================================================

import type { ToolDefinition, ExecutableSkill } from '../types.js'

export interface Capability {
  name: string
  description: string
  /** Tool names that provide this capability */
  tools: string[]
  /** Skill IDs that provide this capability */
  skills: string[]
  /** 0-1 confidence based on available tools/skills */
  confidence: number
  /** Keywords (English + Chinese) that indicate this capability is needed */
  keywords: string[]
}

export interface FeasibilityResult {
  feasible: boolean
  confidence: number
  matchedCapabilities: string[]
  missingCapabilities: string[]
  suggestion: string
}

/** Static capability definitions (confidence filled at refresh time) */
type CapabilityTemplate = Omit<Capability, 'confidence'>

const BUILTIN_CAPABILITIES: CapabilityTemplate[] = [
  {
    name: 'shell-execution',
    description: 'Run shell/terminal commands',
    tools: ['shell'],
    skills: [],
    keywords: ['command', 'terminal', 'shell', 'run', 'execute', 'bash', '命令', '终端', '运行'],
  },
  {
    name: 'file-operations',
    description: 'Read and write files on the filesystem',
    tools: ['file_read', 'file_write'],
    skills: ['file-batch'],
    keywords: ['file', 'read', 'write', 'save', 'create file', '文件', '读取', '写入', '保存'],
  },
  {
    name: 'web-browsing',
    description: 'Navigate web pages, interact with web UIs',
    tools: ['browser'],
    skills: ['web-search', 'summarize-url'],
    keywords: ['browse', 'website', 'web', 'page', 'url', 'navigate', '浏览', '网页', '网站'],
  },
  {
    name: 'http-requests',
    description: 'Make HTTP/API requests',
    tools: ['http'],
    skills: ['data-extract'],
    keywords: ['api', 'http', 'request', 'fetch', 'rest', '请求', '接口'],
  },
  {
    name: 'web-search',
    description: 'Search the web for information',
    tools: [],
    skills: ['web-search'],
    keywords: ['search', 'google', 'find info', 'look up', '搜索', '查找', '搜一下'],
  },
  {
    name: 'code-analysis',
    description: 'Analyze and understand code',
    tools: ['file_read', 'shell'],
    skills: ['code-analysis'],
    keywords: ['analyze', 'code', 'debug', 'explain', 'function', '分析', '代码', '调试'],
  },
  {
    name: 'github',
    description: 'Interact with GitHub (issues, PRs, repos)',
    tools: ['shell'],
    skills: ['github'],
    keywords: ['github', 'issue', 'pull request', 'pr', 'repo', '仓库'],
  },
  {
    name: 'scheduling',
    description: 'Schedule tasks to run at intervals',
    tools: [],
    skills: ['schedule'],
    keywords: ['schedule', 'cron', 'timer', 'interval', '定时', '计划'],
  },
  // Capabilities the agent does NOT have (empty tools + skills → confidence 0)
  {
    name: 'email',
    description: 'Send or read emails',
    tools: [],
    skills: [],
    keywords: ['email', 'mail', 'send email', '邮件', '发邮件'],
  },
  {
    name: 'messaging',
    description: 'Send messages on platforms (WeChat, Slack, etc)',
    tools: [],
    skills: [],
    keywords: ['wechat', 'slack', 'telegram', 'message', 'send message', '微信', '发消息', '短信'],
  },
  {
    name: 'database',
    description: 'Direct database operations (SQL, MongoDB, etc)',
    tools: [],
    skills: [],
    keywords: ['database', 'sql', 'mongodb', 'query', 'table', '数据库', '查询'],
  },
  {
    name: 'image-generation',
    description: 'Generate or edit images',
    tools: [],
    skills: [],
    keywords: ['generate image', 'draw', 'create image', '生成图片', '画图', '图像'],
  },
]

export class CapabilityMap {
  private capabilities: Capability[] = []

  constructor() {
    this.initBuiltinCapabilities()
  }

  /**
   * Initialize capabilities with zero confidence.
   * Call refresh() with actual tool/skill inventories to score them.
   */
  private initBuiltinCapabilities(): void {
    this.capabilities = BUILTIN_CAPABILITIES.map((tpl) => ({
      ...tpl,
      confidence: 0,
    }))
  }

  /** Rebuild capability map from current tool and skill registries */
  refresh(tools: ToolDefinition[], skills: ExecutableSkill[]): void {
    const toolNames = new Set(tools.map((t) => t.name))
    const skillIds = new Set(
      skills.filter((s) => s.available !== false).map((s) => s.id),
    )

    // Score each builtin capability
    this.capabilities = BUILTIN_CAPABILITIES.map((tpl) => {
      const confidence = computeConfidence(tpl, toolNames, skillIds)
      return { ...tpl, confidence }
    })

    // Add dynamic capabilities for skills not covered by any builtin
    const coveredSkillIds = new Set(
      BUILTIN_CAPABILITIES.flatMap((c) => c.skills),
    )
    for (const skill of skills) {
      if (coveredSkillIds.has(skill.id) || skill.available === false) continue
      this.capabilities.push({
        name: `skill:${skill.id}`,
        description: skill.description,
        tools: [],
        skills: [skill.id],
        confidence: 1.0,
        keywords: [...skill.triggers],
      })
    }
  }

  /** Assess whether a task is feasible given current capabilities */
  assess(taskDescription: string): FeasibilityResult {
    const tokens = tokenize(taskDescription)
    const matched: string[] = []
    const missing: string[] = []

    for (const cap of this.capabilities) {
      if (!keywordsMatch(tokens, cap.keywords)) continue
      if (cap.confidence > 0) {
        matched.push(cap.name)
      } else {
        missing.push(cap.name)
      }
    }

    // No capabilities matched — likely a generic conversational task
    if (matched.length === 0 && missing.length === 0) {
      return {
        feasible: true,
        confidence: 0.5,
        matchedCapabilities: [],
        missingCapabilities: [],
        suggestion: 'This looks like a general conversational task — no specific tool capabilities required.',
      }
    }

    // All matched capabilities are available
    if (missing.length === 0) {
      return {
        feasible: true,
        confidence: Math.min(...matched.map((n) => this.getConfidence(n))),
        matchedCapabilities: matched,
        missingCapabilities: [],
        suggestion: `I can handle this using: ${matched.join(', ')}.`,
      }
    }

    // Some capabilities are missing
    if (matched.length > 0) {
      return {
        feasible: false,
        confidence: 0,
        matchedCapabilities: matched,
        missingCapabilities: missing,
        suggestion:
          `I can partially handle this (available: ${matched.join(', ')}), ` +
          `but I lack: ${missing.join(', ')}. ` +
          `I'll do what I can and let you know what's missing.`,
      }
    }

    // Everything required is missing
    return {
      feasible: false,
      confidence: 0,
      matchedCapabilities: [],
      missingCapabilities: missing,
      suggestion:
        `I don't have the capability for this task. Missing: ${missing.join(', ')}. ` +
        `You may need an external tool or service to accomplish this.`,
    }
  }

  /** Get all capabilities */
  list(): Capability[] {
    return [...this.capabilities]
  }

  /** Get capability description for planner prompt injection */
  describeForPlanner(): string {
    const available = this.capabilities
      .filter((c) => c.confidence > 0)
      .map((c) => c.description)
    const unavailable = this.capabilities
      .filter((c) => c.confidence === 0)
      .map((c) => c.description)

    const lines = ['## Agent Capabilities']
    if (available.length > 0) {
      lines.push(`Available: ${available.join(', ')}`)
    }
    if (unavailable.length > 0) {
      lines.push(`Not available: ${unavailable.join(', ')}`)
    }
    return lines.join('\n')
  }

  /** Internal: get confidence for a capability by name */
  private getConfidence(name: string): number {
    return this.capabilities.find((c) => c.name === name)?.confidence ?? 0
  }
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Compute confidence for a capability template based on which
 * of its required tools and skills are actually present.
 *
 * - 1.0 if all declared tools + skills are present
 * - 0.5 if at least one is present but not all
 * - 0.0 if none are present (or the template declares nothing)
 */
function computeConfidence(
  tpl: CapabilityTemplate,
  toolNames: Set<string>,
  skillIds: Set<string>,
): number {
  const total = tpl.tools.length + tpl.skills.length
  if (total === 0) return 0

  let present = 0
  for (const t of tpl.tools) {
    if (toolNames.has(t)) present++
  }
  for (const s of tpl.skills) {
    if (skillIds.has(s)) present++
  }

  if (present === 0) return 0
  if (present === total) return 1
  return 0.5
}

/**
 * Tokenize a task description into lowercase segments for matching.
 * Handles both English words and Chinese characters/phrases.
 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  // Split on whitespace and punctuation, keep Chinese chars as individual tokens
  const tokens = lower.split(/[\s,;.!?，；。！？、]+/).filter(Boolean)
  return tokens
}

/**
 * Check whether any keyword matches the tokenized task description.
 * Multi-word keywords are matched as substring of the original (lowered) text.
 */
function keywordsMatch(tokens: string[], keywords: string[]): boolean {
  const joined = tokens.join(' ')
  for (const kw of keywords) {
    const lower = kw.toLowerCase()
    // Multi-word keyword: substring match
    if (lower.includes(' ')) {
      if (joined.includes(lower)) return true
      continue
    }
    // Single-word / Chinese keyword: check token containment
    if (tokens.some((t) => t.includes(lower) || lower.includes(t))) return true
  }
  return false
}
