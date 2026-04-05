import chalk from 'chalk'
import type { AgentEvent, ExecutionStep, Plan } from '@evolving-agent/core'

export function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'planning': {
      if (typeof event.data === 'string') {
        console.log(chalk.cyan(`  ${event.data}`))
      } else {
        const plan = event.data as Plan
        if (plan.steps.length > 0) {
          console.log(chalk.cyan(`\n  Plan: ${plan.task}`))
          for (const step of plan.steps) {
            const tool = step.tool ? chalk.dim(` [${step.tool}]`) : ''
            console.log(chalk.cyan(`    ${step.id}. ${step.description}${tool}`))
          }
          console.log()
        }
      }
      break
    }

    case 'executing':
      console.log(chalk.yellow(`  ${event.data}`))
      break

    case 'tool-result': {
      const step = event.data as ExecutionStep
      const icon = step.result.success ? chalk.green('✓') : chalk.red('✗')
      const output = step.result.output
        ? chalk.dim(`\n    ${step.result.output.split('\n').slice(0, 5).join('\n    ')}`)
        : ''
      const error = step.result.error ? chalk.red(`\n    Error: ${step.result.error}`) : ''
      console.log(`  ${icon} ${step.description} ${chalk.dim(`(${step.duration}ms)`)}${output}${error}`)
      break
    }

    case 'error': {
      const step = event.data as ExecutionStep
      console.log(chalk.red(`  ✗ ${step.description}: ${step.result.error}`))
      break
    }

    case 'reflecting':
      console.log(chalk.dim(`  ${event.data}`))
      break

    case 'hook':
      console.log(chalk.dim(`  [hook] ${event.data}`))
      break

    case 'message': {
      const msg = event.data as { role: string; content: string }
      if (msg.role === 'assistant') {
        console.log(chalk.white(`\n${msg.content}\n`))
      }
      break
    }
  }
}

export function renderMetrics(metrics: { totalCalls: number; totalCost: number; totalSavedCost: number; avgCacheHitRate: number; totalPromptTokens: number; totalCompletionTokens: number; totalCacheRead: number; totalCacheWrite: number }): void {
  console.log(chalk.bold('\n  Token & Cost Statistics'))
  console.log(chalk.dim('  ──────────────────────'))
  console.log(`  Total LLM calls:    ${metrics.totalCalls}`)
  console.log(`  Prompt tokens:      ${metrics.totalPromptTokens.toLocaleString()}`)
  console.log(`  Completion tokens:  ${metrics.totalCompletionTokens.toLocaleString()}`)
  console.log(`  Cache read tokens:  ${metrics.totalCacheRead.toLocaleString()}`)
  console.log(`  Cache write tokens: ${metrics.totalCacheWrite.toLocaleString()}`)
  console.log(`  Avg cache hit rate: ${(metrics.avgCacheHitRate * 100).toFixed(1)}%`)
  console.log(`  Total cost:         $${metrics.totalCost.toFixed(4)}`)
  console.log(`  Saved by cache:     $${metrics.totalSavedCost.toFixed(4)}`)
  console.log()
}

export function renderExperiences(experiences: Array<{ id: string; task: string; result: string; admissionScore: number; timestamp: string; tags: string[] }>): void {
  if (experiences.length === 0) {
    console.log(chalk.dim('  No experiences stored yet.\n'))
    return
  }
  console.log(chalk.bold(`\n  Stored Experiences (${experiences.length})`))
  console.log(chalk.dim('  ──────────────────────'))
  for (const exp of experiences) {
    const icon = exp.result === 'success' ? chalk.green('✓') : exp.result === 'partial' ? chalk.yellow('~') : chalk.red('✗')
    const score = chalk.dim(`(score: ${exp.admissionScore.toFixed(2)})`)
    const tags = exp.tags.length > 0 ? chalk.dim(` [${exp.tags.join(', ')}]`) : ''
    console.log(`  ${icon} ${exp.task.slice(0, 60)} ${score}${tags}`)
  }
  console.log()
}
