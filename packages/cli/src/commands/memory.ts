import * as p from '@clack/prompts'
import { MemoryManager } from '@evolving-agent/core'
import { renderExperiences } from '../ui/renderer.js'
import { resolve } from 'node:path'

export async function memoryCommand(): Promise<void> {
  const dataPath = resolve(process.cwd(), 'data', 'memory')
  const memory = new MemoryManager(dataPath)
  await memory.init()

  const experiences = memory.experienceStore.getAll('all')
  renderExperiences(experiences)

  // Run maintenance
  const result = await memory.maintain()
  if (result.movedToStale > 0 || result.movedToArchive > 0) {
    p.log.info(`Maintenance: ${result.movedToStale} moved to stale, ${result.movedToArchive} archived`)
  }
}
