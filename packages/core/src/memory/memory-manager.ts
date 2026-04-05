import type { Experience, ExecutionStep, Reflection, RetrievalQuery, RetrievalResult } from '../types.js'
import { ShortTermMemory } from './short-term.js'
import { ExperienceStore } from './experience-store.js'
import { MemoryRetriever } from './retriever.js'
import type { RetrieverConfig } from './retriever.js'
import { VectorIndex } from './vector-index.js'
import type { Embedder } from './embedder.js'
import { computeAdmission } from './admission.js'
import { nanoid } from 'nanoid'

export class MemoryManager {
  readonly shortTerm: ShortTermMemory
  readonly experienceStore: ExperienceStore
  readonly retriever: MemoryRetriever
  private vectorIndex?: VectorIndex
  private embedder?: Embedder

  constructor(dataPath: string, embedder?: Embedder, retrieverConfig?: RetrieverConfig) {
    this.shortTerm = new ShortTermMemory()
    this.experienceStore = new ExperienceStore(dataPath)
    this.embedder = embedder

    if (embedder) {
      this.vectorIndex = new VectorIndex()
    }

    this.retriever = new MemoryRetriever(
      this.experienceStore,
      this.vectorIndex,
      this.embedder,
      retrieverConfig,
    )
  }

  async init(): Promise<void> {
    await this.experienceStore.init()

    // Populate vector index from existing experiences that have embeddings
    if (this.vectorIndex) {
      const experiences = this.experienceStore.getAll('all')
      for (const exp of experiences) {
        if (exp.embedding && exp.embedding.length > 0) {
          this.vectorIndex.add(exp.id, exp.embedding)
        }
      }
    }
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

    // Generate embedding if embedder is available
    let embedding: number[] | undefined
    if (this.embedder) {
      try {
        // Embed a composite text: task + lesson + tags for richer representation
        const embeddingText = [task, reflection.lesson, ...tags].join(' ')
        embedding = await this.embedder.embed(embeddingText)
      } catch {
        // Embedding failure is non-fatal; experience is stored without embedding
      }
    }

    const experience: Experience = {
      id: nanoid(),
      task,
      steps,
      result,
      reflection,
      tags,
      timestamp: new Date().toISOString(),
      ...(embedding ? { embedding } : {}),
      health: { referencedCount: 0, contradictionCount: 0 },
      admissionScore: admission.score,
    }

    await this.experienceStore.save(experience)

    // Add to vector index
    if (this.vectorIndex && embedding) {
      this.vectorIndex.add(experience.id, embedding)
    }

    return { stored: true, experience, score: admission.score, decision: admission.decision }
  }

  /**
   * Reindex all experiences that lack embeddings.
   * Generates embeddings and persists them back to the store.
   */
  async reindex(): Promise<{ processed: number; errors: number }> {
    if (!this.embedder) {
      return { processed: 0, errors: 0 }
    }

    const experiences = this.experienceStore.getAll('all')
    let processed = 0
    let errors = 0

    for (const exp of experiences) {
      // Skip experiences that already have embeddings
      if (exp.embedding && exp.embedding.length > 0) continue

      try {
        const embeddingText = [exp.task, exp.reflection.lesson, ...exp.tags].join(' ')
        const embedding = await this.embedder.embed(embeddingText)

        // Update the experience with the new embedding
        exp.embedding = embedding
        await this.experienceStore.save(exp)

        // Add to vector index
        if (this.vectorIndex) {
          this.vectorIndex.add(exp.id, embedding)
        }

        processed++
      } catch {
        errors++
      }
    }

    return { processed, errors }
  }

  /** Run periodic maintenance (pool transitions) */
  async maintain(): Promise<{ movedToStale: number; movedToArchive: number }> {
    return this.experienceStore.maintain()
  }
}
