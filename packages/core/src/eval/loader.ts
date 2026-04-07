import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { EvalCase, EvalCriterion } from './types.js'

/**
 * Load every `*.json` file under `casesDir`, parse and validate as an
 * `EvalCase`, optionally filter by tags/ids, and return sorted by id.
 *
 * Missing required fields throw — eval case authoring is a one-time act and
 * a noisy loader is better than silently skipping malformed cases.
 */
export async function loadEvalCases(
  casesDir: string,
  filter?: { tags?: string[]; ids?: string[] },
): Promise<EvalCase[]> {
  let entries: string[]
  try {
    entries = await readdir(casesDir)
  } catch (err) {
    throw new Error(
      `Failed to read eval cases directory "${casesDir}": ${(err as Error).message}`,
    )
  }

  const jsonFiles = entries.filter((f) => f.endsWith('.json'))
  const cases: EvalCase[] = []

  for (const file of jsonFiles) {
    const fullPath = join(casesDir, file)
    let raw: string
    try {
      raw = await readFile(fullPath, 'utf-8')
    } catch (err) {
      throw new Error(`Failed to read eval case "${fullPath}": ${(err as Error).message}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`Invalid JSON in eval case "${fullPath}": ${(err as Error).message}`)
    }

    validateEvalCase(parsed, fullPath)
    cases.push(parsed as EvalCase)
  }

  const tagSet = filter?.tags && filter.tags.length > 0 ? new Set(filter.tags) : undefined
  const idSet = filter?.ids && filter.ids.length > 0 ? new Set(filter.ids) : undefined

  const filtered = cases.filter((c) => {
    if (idSet && !idSet.has(c.id)) return false
    if (tagSet && !c.tags.some((t) => tagSet.has(t))) return false
    return true
  })

  filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return filtered
}

function validateEvalCase(value: unknown, path: string): asserts value is EvalCase {
  if (!value || typeof value !== 'object') {
    throw new Error(`Eval case "${path}" is not an object`)
  }
  const v = value as Record<string, unknown>
  requireString(v, 'id', path)
  requireString(v, 'title', path)
  requireString(v, 'input', path)
  if (!Array.isArray(v.tags) || !v.tags.every((t) => typeof t === 'string')) {
    throw new Error(`Eval case "${path}" missing string[] "tags"`)
  }
  if (!Array.isArray(v.criteria) || v.criteria.length === 0) {
    throw new Error(`Eval case "${path}" must have at least one criterion`)
  }
  for (const [i, c] of v.criteria.entries()) {
    validateCriterion(c, `${path}#criteria[${i}]`)
  }
  if (v.timeoutMs !== undefined && typeof v.timeoutMs !== 'number') {
    throw new Error(`Eval case "${path}" has non-numeric "timeoutMs"`)
  }
}

function requireString(obj: Record<string, unknown>, key: string, path: string): void {
  if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
    throw new Error(`Eval case "${path}" missing required string field "${key}"`)
  }
}

function validateCriterion(value: unknown, path: string): asserts value is EvalCriterion {
  if (!value || typeof value !== 'object') {
    throw new Error(`Criterion "${path}" is not an object`)
  }
  const v = value as Record<string, unknown>
  const type = v.type
  switch (type) {
    case 'contains':
    case 'not-contains':
      if (typeof v.substring !== 'string') {
        throw new Error(`Criterion "${path}" (${type}) missing "substring"`)
      }
      return
    case 'regex':
      if (typeof v.pattern !== 'string') {
        throw new Error(`Criterion "${path}" (regex) missing "pattern"`)
      }
      return
    case 'tool-called':
    case 'tool-not-called':
      if (typeof v.tool !== 'string') {
        throw new Error(`Criterion "${path}" (${type}) missing "tool"`)
      }
      return
    case 'llm-judge':
      if (typeof v.rubric !== 'string') {
        throw new Error(`Criterion "${path}" (llm-judge) missing "rubric"`)
      }
      return
    case 'json-shape':
      if (!Array.isArray(v.requiredKeys) || !v.requiredKeys.every((k) => typeof k === 'string')) {
        throw new Error(`Criterion "${path}" (json-shape) missing string[] "requiredKeys"`)
      }
      return
    default:
      throw new Error(`Criterion "${path}" has unknown type "${String(type)}"`)
  }
}
