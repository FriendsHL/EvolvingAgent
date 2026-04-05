import type { ExecutionStep, Plan, PlanStep, ToolResult, SkillContext } from '../types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { HookRunner } from '../hooks/hook-runner.js'
import type { HookContext } from '../types.js'
import type { SkillRegistry } from '../skills/skill-registry.js'

export class Executor {
  constructor(
    private tools: ToolRegistry,
    private hookRunner: HookRunner,
    private skills?: SkillRegistry,
    private skillContext?: SkillContext,
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

    // Check if this is a skill invocation (tool = "skill:<id>")
    if (step.tool.startsWith('skill:')) {
      return this.executeSkill(step, startTime)
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

  private async executeSkill(step: PlanStep, startTime: number): Promise<ExecutionStep> {
    const skillId = step.tool!.replace('skill:', '')
    const skill = this.skills?.get(skillId)

    if (!skill) {
      return {
        ...step,
        result: { success: false, output: '', error: `Skill not found: ${skillId}` },
        duration: Date.now() - startTime,
      }
    }

    if (!this.skillContext) {
      return {
        ...step,
        result: { success: false, output: '', error: 'Skill context not available' },
        duration: Date.now() - startTime,
      }
    }

    try {
      const skillResult = await skill.execute(step.params ?? {}, this.skillContext)
      return {
        ...step,
        result: {
          success: skillResult.success,
          output: skillResult.output,
          error: skillResult.error,
        },
        duration: Date.now() - startTime,
      }
    } catch (err) {
      return {
        ...step,
        result: { success: false, output: '', error: `Skill error: ${(err as Error).message}` },
        duration: Date.now() - startTime,
      }
    }
  }
}
