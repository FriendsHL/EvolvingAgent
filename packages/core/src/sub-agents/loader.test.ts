import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SubAgentRegistry, parseSubAgentMarkdown } from './loader.js'

const thisFileDir = dirname(fileURLToPath(import.meta.url))
const BUILTIN_DIR = join(thisFileDir, 'builtin')

describe('SubAgentRegistry', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'sub-agents-test-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('loads the shipped research builtin', async () => {
    const registry = new SubAgentRegistry()
    await registry.init({ builtinDir: BUILTIN_DIR })
    const research = registry.get('research')
    expect(research).toBeDefined()
    expect(research?.name).toBe('research')
    expect(research?.description.toLowerCase()).toContain('fresh')
    expect(research?.tools).toContain('browser')
    expect(research?.skills).toContain('web-search')
    expect(research?.memory).toBe('none')
    expect(research?.maxIterations).toBe(8)
    expect(research?.identityPrompt.length).toBeGreaterThan(100)
    expect(research?.identityPrompt).toContain('# Identity')
  })

  it('user override replaces a builtin by name', async () => {
    const userDir = join(tempRoot, 'user')
    await mkdir(userDir, { recursive: true })
    await writeFile(
      join(userDir, 'research.md'),
      `---\nname: research\ndescription: Overridden research specialist\ntools: [http]\nmemory: none\nmax_iterations: 4\n---\n\n# Identity\n\nOverridden body.\n`,
      'utf-8',
    )
    const registry = new SubAgentRegistry()
    await registry.init({ builtinDir: BUILTIN_DIR, userDir })
    const research = registry.get('research')
    expect(research?.description).toBe('Overridden research specialist')
    expect(research?.tools).toEqual(['http'])
    expect(research?.maxIterations).toBe(4)
    expect(research?.identityPrompt).toContain('Overridden body.')
  })

  it('missing name throws a descriptive error', async () => {
    const badDir = join(tempRoot, 'bad')
    await mkdir(badDir, { recursive: true })
    const badFile = join(badDir, 'nameless.md')
    await writeFile(
      badFile,
      `---\ndescription: I have no name\ntools: []\n---\n\nBody.\n`,
      'utf-8',
    )
    const registry = new SubAgentRegistry()
    await expect(registry.init({ builtinDir: badDir })).rejects.toThrow(/missing required "name"/)
  })

  it('missing description throws a descriptive error', async () => {
    const badDir = join(tempRoot, 'bad')
    await mkdir(badDir, { recursive: true })
    await writeFile(
      join(badDir, 'no-desc.md'),
      `---\nname: orphan\ntools: []\n---\n\nBody.\n`,
      'utf-8',
    )
    const registry = new SubAgentRegistry()
    await expect(registry.init({ builtinDir: badDir })).rejects.toThrow(
      /missing required "description"/,
    )
  })

  it('describeForRouter formats a non-empty catalog', async () => {
    const registry = new SubAgentRegistry()
    await registry.init({ builtinDir: BUILTIN_DIR })
    const catalog = registry.describeForRouter()
    // Each def gets one line, prefixed with "- <name>: ". The order is
    // alphabetical so the first entry depends on how many builtins exist;
    // use a shape check, not a hardcoded name.
    expect(catalog).toMatch(/^- \w+: .+/)
    expect(catalog.split('\n').length).toBe(registry.list().length)
    // All four builtins present in the catalog.
    expect(catalog).toContain('- research:')
    expect(catalog).toContain('- system:')
    expect(catalog).toContain('- code:')
    expect(catalog).toContain('- analysis:')
  })

  it('parseSubAgentMarkdown rejects a file with no frontmatter', () => {
    expect(() => parseSubAgentMarkdown('just a body, no frontmatter', '/tmp/x.md')).toThrow(
      /missing a YAML frontmatter block/,
    )
  })
})
