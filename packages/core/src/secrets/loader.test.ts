import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSecrets, expandPlaceholders, findMissingPlaceholders } from './loader.js'

let dataPath: string
beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'secrets-loader-test-'))
})
afterEach(async () => {
  await rm(dataPath, { recursive: true, force: true })
})

async function writeSecrets(body: unknown): Promise<void> {
  await mkdir(join(dataPath, 'config'), { recursive: true })
  await writeFile(join(dataPath, 'config', 'secrets.json'), JSON.stringify(body), 'utf-8')
}

describe('loadSecrets', () => {
  it('returns empty bag when file is missing (loaded=false, no throw)', async () => {
    const r = await loadSecrets(dataPath)
    expect(r.loaded).toBe(false)
    expect(r.secrets).toEqual({})
  })

  it('loads scalar key/value pairs', async () => {
    await writeSecrets({ FOO: 'bar', NUM: 42, FLAG: true })
    const r = await loadSecrets(dataPath)
    expect(r.loaded).toBe(true)
    expect(r.secrets).toEqual({ FOO: 'bar', NUM: '42', FLAG: 'true' })
  })

  it('skips null/undefined values', async () => {
    await writeSecrets({ KEEP: 'yes', DROP: null })
    const r = await loadSecrets(dataPath)
    expect(r.secrets).toEqual({ KEEP: 'yes' })
  })

  it('throws on nested objects (avoid silent typos)', async () => {
    await writeSecrets({ BAD: { nested: 'no' } })
    await expect(loadSecrets(dataPath)).rejects.toThrow(/scalar value/)
  })

  it('throws on top-level non-object', async () => {
    await mkdir(join(dataPath, 'config'), { recursive: true })
    await writeFile(join(dataPath, 'config', 'secrets.json'), '"just a string"', 'utf-8')
    await expect(loadSecrets(dataPath)).rejects.toThrow(/top-level JSON object/)
  })

  it('throws on malformed JSON', async () => {
    await mkdir(join(dataPath, 'config'), { recursive: true })
    await writeFile(join(dataPath, 'config', 'secrets.json'), '{not json', 'utf-8')
    await expect(loadSecrets(dataPath)).rejects.toThrow(/Invalid JSON/)
  })
})

describe('expandPlaceholders', () => {
  it('substitutes ${VAR} from secrets bag', () => {
    const r = expandPlaceholders(
      { TOKEN: 'Bearer ${KEY}' },
      { KEY: 'abc123' },
      {},
    )
    expect(r.expanded.TOKEN).toBe('Bearer abc123')
    expect(r.missing).toEqual([])
  })

  it('falls through to process.env', () => {
    const r = expandPlaceholders(
      { X: '${ENV_VAR}' },
      {},
      { ENV_VAR: 'from-env' },
    )
    expect(r.expanded.X).toBe('from-env')
    expect(r.missing).toEqual([])
  })

  it('records missing placeholders without throwing', () => {
    const r = expandPlaceholders(
      { A: '${HAS}', B: '${MISSING}' },
      { HAS: 'ok' },
      {},
    )
    expect(r.expanded.A).toBe('ok')
    expect(r.expanded.B).toBe('') // placeholder substituted with ''
    expect(r.missing).toEqual(['MISSING'])
  })

  it('returns empty result for undefined input', () => {
    const r = expandPlaceholders(undefined, {}, {})
    expect(r.expanded).toEqual({})
    expect(r.missing).toEqual([])
  })

  it('handles strings with no placeholders unchanged', () => {
    const r = expandPlaceholders({ X: 'plain text' }, {}, {})
    expect(r.expanded.X).toBe('plain text')
  })

  it('does NOT expand bareword $VAR (only ${VAR})', () => {
    const r = expandPlaceholders({ X: '$VAR' }, { VAR: 'no' }, {})
    expect(r.expanded.X).toBe('$VAR')
  })
})

describe('findMissingPlaceholders', () => {
  it('returns the unique set of unresolved names', () => {
    const missing = findMissingPlaceholders(
      { A: '${X}-${Y}', B: '${X}-${Z}' },
      { X: 'ok' },
      {},
    )
    expect(missing.sort()).toEqual(['Y', 'Z'])
  })

  it('returns [] when everything is resolvable', () => {
    const missing = findMissingPlaceholders(
      { A: '${X}' },
      {},
      { X: 'env-value' },
    )
    expect(missing).toEqual([])
  })

  it('returns [] for undefined input', () => {
    expect(findMissingPlaceholders(undefined, {})).toEqual([])
  })
})
