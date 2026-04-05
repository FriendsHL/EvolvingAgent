import type { Experience, ExecutionStep, Reflection, RetrievalQuery, RetrievalResult } from '../types.js'
import { ShortTermMemory } from './short-term.js'
import { ExperienceStore } from './experience-store.js'
import { MemoryRetriever } from './retriever.js'
import { computeAdmission } from './admission.js'
import { nanoid } from 'nanoid'

export class MemoryManager {
  readonly shortTerm: ShortTermMemory
  readonly experienceStore: ExperienceStore
  readonly retriever: MemoryRetriever

  constructor(dataPath: string) {
    this.shortTerm = new ShortTermMemory()
    this.experienceStore = new ExperienceStore(dataPath)
    this.retriever = new MemoryRetriever(this.experienceStore)
  }

  async init(): Promise<void> {
    await this.experienceStore.init()
  }

  /** Add a message to conversation history */
  addMessage(role: 'user' | 'assistant', content: string): void {
    this.shortTerm.add(role, content)
  }

  /** Get conversation history for prompt building */
  getHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.shortTerm.getHistory()
  }

  /** Search for related experiences */
  async search(query: RetrievalQuery): Promise<RetrievalResult[]> {
    return this.retriever.search(query)
  }

  /**
   * Evaluate and optionally store a new experience.
   * Returns the admission result — caller decides what to do on 'discard'.
   */
  async storeExperience(
    task: string,
    steps: ExecutionStep[],
    result: 'success' | 'partial' | 'failure',
    reflection: Reflection,
    tags: string[],
  ): Promise<{ stored: boolean; experience?: Experience; score: number; decision: string }> {
    const existingTasks = this.experienceStore.getAllTasks()
    const admission = computeAdmission(task, steps, result, reflection, tags, existingTasks)

    if (admission.decision === 'discard') {
      return { stored: false, score: admission.score, decision: admission.decision }
    }

    const experience: Experience = {
      id: nanoid(),
      task,
      steps,
      result,
      reflection,
      tags,
      timestamp: new Date().toISOString(),
      health: { referencedCount: 0, contradictionCount: 0 },
      admissionScore: admission.score,
    }

    await this.experienceStore.save(experience)

    return { stored: true, experience, score: admission.score, decision: admission.decision }
  }

  /** Run periodic maintenance (pool transitions) */
  async maintain(): Promise<{ movedToStale: number; movedToArchive: number }> {
    return this.experienceStore.maintain()
  }
}
