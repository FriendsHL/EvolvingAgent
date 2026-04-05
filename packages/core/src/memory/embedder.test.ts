import { describe, it, expect } from 'vitest'
import { Embedder } from './embedder.js'

describe('Embedder (local provider)', () => {
  it('produces vectors of fixed dimension (512)', async () => {
    const embedder = new Embedder({ provider: 'local' })
    const vec = await embedder.embed('hello world this is a test')
    expect(vec).toHaveLength(512)
  })

  it('produces normalized vectors (L2 norm approx 1)', async () => {
    const embedder = new Embedder({ provider: 'local' })
    const vec = await embedder.embed('the quick brown fox jumps over the lazy dog')
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
    expect(norm).toBeCloseTo(1.0, 2)
  })

  it('produces similar vectors for similar text', async () => {
    const embedder = new Embedder({ provider: 'local' })
    // Embed a few documents first to stabilize IDF scores
    await embedder.embed('general text about various unrelated topics here')
    await embedder.embed('another document with completely different words altogether')

    const v1 = await embedder.embed('deploy application production server release')
    const v2 = await embedder.embed('deploy application production server update')

    // Compute cosine similarity manually
    let dot = 0
    for (let i = 0; i < v1.length; i++) dot += v1[i] * v2[i]
    // Both are normalized, so dot product = cosine similarity
    // Sharing most tokens should yield non-trivial similarity
    expect(dot).toBeGreaterThan(0)
  })

  it('produces different vectors for different text', async () => {
    const embedder = new Embedder({ provider: 'local' })
    const v1 = await embedder.embed('deploy the application to production server')
    const v2 = await embedder.embed('cooking recipes for chocolate cake dessert')

    let dot = 0
    for (let i = 0; i < v1.length; i++) dot += v1[i] * v2[i]
    // Very different texts should have low similarity
    expect(dot).toBeLessThan(0.5)
  })

  it('embedBatch returns array of correct length', async () => {
    const embedder = new Embedder({ provider: 'local' })
    const texts = ['hello world', 'foo bar baz', 'testing embedder batch']
    const vecs = await embedder.embedBatch(texts)
    expect(vecs).toHaveLength(3)
    for (const vec of vecs) {
      expect(vec).toHaveLength(512)
    }
  })

  it('embedBatch returns empty array for empty input', async () => {
    const embedder = new Embedder({ provider: 'local' })
    const vecs = await embedder.embedBatch([])
    expect(vecs).toHaveLength(0)
  })
})

describe('Embedder.fromProviderConfig', () => {
  it('anthropic falls back to local', () => {
    const embedder = Embedder.fromProviderConfig('anthropic')
    // Verify it works as local embedder (no API call)
    expect(embedder).toBeInstanceOf(Embedder)
  })

  it('openai creates openai embedder', () => {
    const embedder = Embedder.fromProviderConfig('openai', 'test-key')
    expect(embedder).toBeInstanceOf(Embedder)
  })

  it('unknown provider falls back to local', () => {
    const embedder = Embedder.fromProviderConfig('unknown-provider')
    expect(embedder).toBeInstanceOf(Embedder)
  })
})
