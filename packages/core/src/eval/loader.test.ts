import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEvalCases } from './loader.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eval-loader-test-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeCase(filename: string, body: object) {
  await writeFile(join(dir, filename), JSON.stringify(body), 'utf-8')
}

const validCase = (id: string, tags: string[] = []) => ({
  id,
  title: `Title for ${id}`,
  input: 'do something',
  tags,
  criteria: [{ type: 'contains', substring: 'foo' }],
})

describe('loadEvalCases', () => {
  it('loads every *.json file and returns them sorted by id', async () => {
    await writeCase('b.json', validCase('beta'))
    await writeCase('a.json', validCase('alpha'))
    await writeCase('not-a-case.txt', {} as any)
    const cases = await loadEvalCases(dir)
    expect(cases.map((c) => c.id)).toEqual(['alpha', 'beta'])
  })

  it('filters by id', async () => {
    await writeCase('a.json', validCase('alpha'))
    await writeCase('b.json', validCase('beta'))
    const cases = await loadEvalCases(dir, { ids: ['beta'] })
    expect(cases.map((c) => c.id)).toEqual(['beta'])
  })

  it('filters by tag (any-match)', async () => {
    await writeCase('a.json', validCase('alpha', ['fast']))
    await writeCase('b.json', validCase('beta', ['slow']))
    await writeCase('c.json', validCase('gamma', ['fast', 'extra']))
    const cases = await loadEvalCases(dir, { tags: ['fast'] })
    expect(cases.map((c) => c.id)).toEqual(['alpha', 'gamma'])
  })

  it('throws on missing required field', async () => {
    await writeCase('bad.json', { id: 'x', title: 'y' } as any)
    await expect(loadEvalCases(dir)).rejects.toThrow(/missing required string field "input"/)
  })

  it('throws on invalid JSON', async () => {
    await writeFile(join(dir, 'bad.json'), '{not json', 'utf-8')
    await expect(loadEvalCases(dir)).rejects.toThrow(/Invalid JSON/)
  })

  it('throws when no criteria', async () => {
    await writeCase('bad.json', { ...validCase('x'), criteria: [] })
    await expect(loadEvalCases(dir)).rejects.toThrow(/at least one criterion/)
  })

  it('throws on unknown criterion type', async () => {
    await writeCase('bad.json', {
      ...validCase('x'),
      criteria: [{ type: 'mystery' }],
    })
    await expect(loadEvalCases(dir)).rejects.toThrow(/unknown type "mystery"/)
  })

  it('throws on missing case directory', async () => {
    await rm(dir, { recursive: true, force: true })
    await expect(loadEvalCases(dir)).rejects.toThrow(/Failed to read eval cases directory/)
    // Recreate so afterEach cleanup is a no-op
    await mkdir(dir, { recursive: true })
  })

  it('returns empty array when directory is empty', async () => {
    expect(await loadEvalCases(dir)).toEqual([])
  })
})
