// ============================================================
// Secrets loader — `data/config/secrets.json` + `${VAR}` expansion
// ============================================================
//
// Why a separate module:
//  - mcp.json is meant to be checked-in / human-edited; secrets.json is
//    NOT (it goes into .gitignore). Keeping the loader independent means
//    other future modules (e.g. webhook receivers, third-party API
//    skills) can reuse the same `${VAR}` expansion convention without
//    pulling in MCP code.
//  - Failing closed but quietly: a missing secret should mark a config
//    entry as "missing-secret" so the caller can auto-skip it, not throw
//    a synchronous error that takes down session startup. This contract
//    is encoded in the return shape: `expandPlaceholders()` returns
//    *both* the (possibly partial) result and a list of missing keys —
//    the caller decides what to do.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Tries to load `<dataPath>/config/secrets.json`. Returns an empty bag
 * (and `loaded: false`) if the file is missing — that is the "user has
 * not configured any secrets yet" state and is NOT an error.
 *
 * Throws ONLY when the file exists but is malformed JSON, since silent
 * acceptance there would mask user typos.
 */
export async function loadSecrets(dataPath: string): Promise<{
  secrets: Record<string, string>
  loaded: boolean
  filePath: string
}> {
  const filePath = join(dataPath, 'config', 'secrets.json')
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`secrets.json must be a top-level JSON object, got ${typeof parsed}`)
    }
    const flat: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      // Coerce numbers/booleans to strings — they're still valid env values.
      // Reject objects/arrays so users don't accidentally nest things.
      if (v === null || v === undefined) continue
      if (typeof v === 'object') {
        throw new Error(`secrets.json key "${k}" must be a scalar value, got ${typeof v}`)
      }
      flat[k] = String(v)
    }
    return { secrets: flat, loaded: true, filePath }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e && e.code === 'ENOENT') {
      return { secrets: {}, loaded: false, filePath }
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${err.message}`)
    }
    throw err
  }
}

/**
 * Expand `${VAR}` placeholders inside a string-keyed bag (e.g. an MCP
 * server's `env`). Returns the expanded copy plus the list of placeholder
 * names that had no matching secret.
 *
 * Resolution order: secrets bag → process.env → undefined (records as
 * missing). We check process.env so users can drop existing CI / shell
 * vars in without copying them to secrets.json.
 *
 * Placeholder syntax: `${VAR}` (POSIX-style). We deliberately do NOT
 * support `$VAR` (bareword) or `${VAR:-default}` — keep the surface area
 * small to avoid surprising users.
 */
export function expandPlaceholders(
  values: Record<string, string> | undefined,
  secrets: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): { expanded: Record<string, string>; missing: string[] } {
  const expanded: Record<string, string> = {}
  const missingSet = new Set<string>()
  if (!values) return { expanded, missing: [] }

  const placeholderRe = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

  for (const [key, raw] of Object.entries(values)) {
    if (typeof raw !== 'string') {
      // Pre-stringified upstream; keep going so we don't lose data.
      expanded[key] = String(raw)
      continue
    }
    const out = raw.replace(placeholderRe, (_, name: string) => {
      if (Object.prototype.hasOwnProperty.call(secrets, name)) return secrets[name]
      const fromEnv = env[name]
      if (fromEnv !== undefined) return fromEnv
      missingSet.add(name)
      return '' // Replaced placeholder with '' — caller will see it in `missing`
    })
    expanded[key] = out
  }

  return { expanded, missing: [...missingSet] }
}

/**
 * Convenience: scan a single string for placeholders and report which are
 * missing, without performing the substitution. Used by the MCP manager
 * to decide "skip this server entirely" before even trying to spawn it.
 */
export function findMissingPlaceholders(
  values: Record<string, string> | undefined,
  secrets: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!values) return []
  const missing = new Set<string>()
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
  for (const raw of Object.values(values)) {
    if (typeof raw !== 'string') continue
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null) {
      const name = m[1]
      if (Object.prototype.hasOwnProperty.call(secrets, name)) continue
      if (env[name] !== undefined) continue
      missing.add(name)
    }
  }
  return [...missing]
}
