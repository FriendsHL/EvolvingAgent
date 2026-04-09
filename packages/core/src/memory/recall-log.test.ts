import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecallLog } from './recall-log.js'

function isoToday(offsetDays = 0): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  // Keep the time portion so sorting by ISO string is stable.
  return d.toISOString()
}

function dateKey(offsetDays = 0): string {
  return isoToday(offsetDays).slice(0, 10)
}

describe('RecallLog', () => {
  let tmpDir: string
  let log: RecallLog

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'recall-log-test-'))
    log = new RecallLog(tmpDir)
    await log.init()
  })

  it('appends an entry and reads it back', async () => {
    await log.append({
      experienceId: 'exp-1',
      query: 'how to parse jsonl',
      similarity: 0.82,
      timestamp: isoToday(0),
      sessionId: 's-1',
    })

    const entries = await log.readRecent(1)
    expect(entries).toHaveLength(1)
    expect(entries[0].experienceId).toBe('exp-1')
    expect(entries[0].query).toBe('how to parse jsonl')
    expect(entries[0].similarity).toBe(0.82)
    expect(entries[0].sessionId).toBe('s-1')
  })

  it('readRecent(1) only returns today when an older day also has entries', async () => {
    // Append an entry with yesterday's date by directly writing the file,
    // since RecallLog.append uses the entry's own timestamp to pick the file.
    await log.append({
      experienceId: 'exp-yesterday',
      query: 'old query',
      similarity: 0.5,
      timestamp: isoToday(-1),
    })
    await log.append({
      experienceId: 'exp-today',
      query: 'new query',
      similarity: 0.7,
      timestamp: isoToday(0),
    })

    const today = await log.readRecent(1)
    expect(today).toHaveLength(1)
    expect(today[0].experienceId).toBe('exp-today')

    const twoDays = await log.readRecent(2)
    expect(twoDays).toHaveLength(2)
    // Time-ascending order: yesterday, then today.
    expect(twoDays[0].experienceId).toBe('exp-yesterday')
    expect(twoDays[1].experienceId).toBe('exp-today')
  })

  it('skips malformed JSON lines instead of crashing', async () => {
    // Write a file by hand with one good line, one garbage line, one good line.
    const logDir = join(tmpDir, 'memory', 'recall-log')
    await mkdir(logDir, { recursive: true })
    const good1 = {
      experienceId: 'g1',
      query: 'q1',
      similarity: 0.4,
      timestamp: isoToday(0),
    }
    const good2 = {
      experienceId: 'g2',
      query: 'q2',
      similarity: 0.6,
      timestamp: isoToday(0),
    }
    const body = [JSON.stringify(good1), '{not valid json}', JSON.stringify(good2), ''].join('\n')
    await writeFile(join(logDir, `${dateKey(0)}.jsonl`), body, 'utf-8')

    const entries = await log.readRecent(1)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.experienceId).sort()).toEqual(['g1', 'g2'])
  })

  it('returns [] for an empty dir', async () => {
    const entries = await log.readRecent(14)
    expect(entries).toEqual([])
  })

  it('returns [] when the log dir does not exist yet', async () => {
    const freshTmp = await mkdtemp(join(tmpdir(), 'recall-log-empty-'))
    const fresh = new RecallLog(freshTmp)
    // Intentionally skip init() to simulate a not-yet-created directory.
    const entries = await fresh.readRecent(14)
    expect(entries).toEqual([])
    // Sanity: we really didn't create anything.
    const listing = await readdir(freshTmp).catch(() => [])
    expect(listing).toEqual([])
  })
})
