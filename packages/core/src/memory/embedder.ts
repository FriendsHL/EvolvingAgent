import { embed, embedMany } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

// ============================================================
// Embedder — multi-backend text embedding
// ============================================================

export interface EmbedderConfig {
  provider: 'openai' | 'openai-compatible' | 'local'
  apiKey?: string
  baseURL?: string
  model?: string
}

// Default models per provider
const DEFAULT_MODELS: Record<EmbedderConfig['provider'], string> = {
  openai: 'text-embedding-3-small',
  'openai-compatible': 'text-embedding-v3',
  local: 'local-bow',
}

export class Embedder {
  private config: EmbedderConfig
  private model: string

  // Local bag-of-words state (used only for 'local' provider)
  private vocabulary = new Map<string, number>()
  private idfScores = new Map<string, number>()
  private docCount = 0
  private static readonly LOCAL_DIM = 512

  constructor(config: EmbedderConfig) {
    this.config = config
    this.model = config.model ?? DEFAULT_MODELS[config.provider]
  }

  /**
   * Create an Embedder from an LLMProvider's configuration.
   * Maps provider types to appropriate embedding backends.
   */
  static fromProviderConfig(providerType: string, apiKey?: string, baseURL?: string): Embedder {
    switch (providerType) {
      case 'openai':
        return new Embedder({ provider: 'openai', apiKey })
      case 'openai-compatible':
        return new Embedder({ provider: 'openai-compatible', apiKey, baseURL })
      case 'anthropic':
        // Anthropic doesn't have its own embedding API; fall back to local
        return new Embedder({ provider: 'local' })
      default:
        return new Embedder({ provider: 'local' })
    }
  }

  async embed(text: string): Promise<number[]> {
    if (this.config.provider === 'local') {
      return this.localEmbed(text)
    }
    return this.apiEmbed(text)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    if (this.config.provider === 'local') {
      return texts.map((t) => this.localEmbed(t))
    }
    return this.apiEmbedBatch(texts)
  }

  // ============================================================
  // API-based embedding (OpenAI / OpenAI-compatible)
  // ============================================================

  private async apiEmbed(text: string): Promise<number[]> {
    const model = this.createEmbeddingModel()
    const result = await embed({ model, value: text })
    return result.embedding
  }

  private async apiEmbedBatch(texts: string[]): Promise<number[][]> {
    const model = this.createEmbeddingModel()
    const result = await embedMany({ model, values: texts })
    return result.embeddings
  }

  private createEmbeddingModel() {
    const provider = createOpenAI({
      apiKey: this.config.apiKey,
      ...(this.config.provider === 'openai-compatible' && this.config.baseURL
        ? { baseURL: this.config.baseURL }
        : {}),
    })
    return provider.textEmbeddingModel(this.model)
  }

  // ============================================================
  // Local bag-of-words TF-IDF embedding (no external API)
  // ============================================================

  private localEmbed(text: string): number[] {
    const tokens = this.tokenize(text)
    this.docCount++

    // Update vocabulary: assign indices to new tokens
    for (const token of tokens) {
      if (!this.vocabulary.has(token)) {
        // Use a hash-based index to keep dimension fixed
        const idx = this.hashToken(token) % Embedder.LOCAL_DIM
        this.vocabulary.set(token, idx)
      }
      // Track document frequency for IDF
      this.idfScores.set(token, (this.idfScores.get(token) ?? 0) + 1)
    }

    // Build TF vector
    const tf = new Map<string, number>()
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1)
    }

    // Build TF-IDF sparse vector projected to fixed dimension
    const vector = new Array<number>(Embedder.LOCAL_DIM).fill(0)
    for (const [token, count] of tf) {
      const idx = this.vocabulary.get(token) ?? (this.hashToken(token) % Embedder.LOCAL_DIM)
      const tfScore = count / tokens.length
      // Use smoothed IDF: log(docCount / (1 + df))
      const df = this.idfScores.get(token) ?? 1
      const idfScore = Math.log((this.docCount + 1) / (1 + df))
      vector[idx] += tfScore * idfScore
    }

    // L2 normalize
    return this.l2Normalize(vector)
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
  }

  /** Simple string hash for mapping tokens to vector indices */
  private hashToken(token: string): number {
    let hash = 0
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0
    }
    return Math.abs(hash)
  }

  private l2Normalize(vector: number[]): number[] {
    let norm = 0
    for (const v of vector) norm += v * v
    norm = Math.sqrt(norm)
    if (norm === 0) return vector
    return vector.map((v) => v / norm)
  }
}
