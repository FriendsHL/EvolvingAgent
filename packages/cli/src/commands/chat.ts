import * as p from '@clack/prompts'
import { Agent } from '@evolving-agent/core'
import { renderEvent, renderMetrics, renderExperiences } from '../ui/renderer.js'
import { resolve } from 'node:path'

export async function chatCommand(): Promise<void> {
  const dataPath = resolve(process.cwd(), 'data', 'memory')

  p.intro('Evolving Agent')

  const agent = new Agent({ dataPath })
  agent.onEvent(renderEvent)

  await agent.init()

  p.log.info('Agent ready. Type your message, or use /memory, /stats, /quit.')

  while (true) {
    const input = await p.text({
      message: '',
      placeholder: 'Type a message...',
    })

    if (p.isCancel(input)) {
      p.outro('Goodbye!')
      break
    }

    const trimmed = (input as string).trim()
    if (!trimmed) continue

    // Slash commands
    if (trimmed === '/quit' || trimmed === '/exit') {
      p.outro('Goodbye!')
      break
    }

    if (trimmed === '/memory') {
      const experiences = agent.getExperiences()
      renderExperiences(experiences)
      continue
    }

    if (trimmed === '/stats') {
      const metrics = agent.getMetrics()
      const totalCost = metrics.reduce((s, m) => s + m.cost, 0)
      const totalSavedCost = metrics.reduce((s, m) => s + m.savedCost, 0)
      const avgCacheHitRate = metrics.length > 0
        ? metrics.reduce((s, m) => s + m.cacheHitRate, 0) / metrics.length
        : 0

      renderMetrics({
        totalCalls: metrics.length,
        totalCost,
        totalSavedCost,
        avgCacheHitRate,
        totalPromptTokens: metrics.reduce((s, m) => s + m.tokens.prompt, 0),
        totalCompletionTokens: metrics.reduce((s, m) => s + m.tokens.completion, 0),
        totalCacheRead: metrics.reduce((s, m) => s + m.tokens.cacheRead, 0),
        totalCacheWrite: metrics.reduce((s, m) => s + m.tokens.cacheWrite, 0),
      })
      continue
    }

    if (trimmed === '/help') {
      p.log.info(`Commands:
  /memory  — View stored experiences
  /stats   — Show token/cost statistics
  /quit    — Exit the agent
  /help    — Show this help`)
      continue
    }

    // Process the message through the agent
    const spinner = p.spinner()
    spinner.start('Thinking...')

    try {
      // Temporarily suppress event rendering during spinner
      await agent.processMessage(trimmed)
      spinner.stop('Done')
    } catch (err) {
      spinner.stop('Error')
      p.log.error((err as Error).message)
    }
  }
}
