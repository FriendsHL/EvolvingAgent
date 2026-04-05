import type { ExecutionStep, Plan, PlanStep, ToolResult } from '../types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { HookRunner } from '../hooks/hook-runner.js'
import type { HookContext } from '../types.js'

export class Executor {
  constructor(
    private tools: ToolRegistry,
    private hookRunner: HookRunner,
  ) {}

  async execute(
    plan: Plan,
    agentContext: HookContext['agent'],
  ): Promise<ExecutionStep[]> {
    const completedSteps: ExecutionStep[] = []
    const completedIds = new Set<string>()

    for (const step of plan.steps) {
      // Check dependencies
      if (step.dependsOn?.some((dep) => !completedIds.has(dep))) {
        completedSteps.push({
          ...step,
          result: { success: false, output: '', error: 'Dependency not met' },
          duration: 0,
        })
        continue
      }

      const executed = await this.executeStep(step, agentContext)
      completedSteps.push(executed)
      completedIds.add(step.id)

      // If a critical step fails, stop execution
      if (!executed.result.success && step.tool) {
        break
      }
    }

    return completedSteps
  }

  private async executeStep(
    step: PlanStep,
    agentContext: HookContext['agent'],
  ): Promise<ExecutionStep> {
    const startTime = Date.now()

    // No tool needed — just a thinking/reasoning step
    if (!step.tool) {
      return {
        ...step,
        result: { success: true, output: step.description },
        duration: Date.now() - startTime,
      }
    }

    // Run before:tool-call hook (can block dangerous commands)
    const hookContext: HookContext = {
      trigger: 'before:tool-call',
      data: { toolName: step.tool, params: step.params ?? {} },
      agent: agentContext,
    }

    try {
      await this.hookRunner.run('before:tool-call', hookContext, {
        toolName: step.tool,
        params: step.params ?? {},
      })
    } catch (err) {
      return {
        ...step,
        result: { success: false, output: '', error: `Hook blocked: ${(err as Error).message}` },
        duration: Date.now() - startTime,
      }
    }

    // Execute the tool
    const result: ToolResult = await this.tools.execute(step.tool, step.params ?? {})

    // Run after:tool-call hook
    const afterContext: HookContext = {
      trigger: 'after:tool-call',
      data: { toolName: step.tool, params: step.params ?? {}, result },
      agent: agentContext,
    }
    await this.hookRunner.run('after:tool-call', afterContext, result)

    return {
      ...step,
      result,
      duration: Date.now() - startTime,
    }
  }
}
