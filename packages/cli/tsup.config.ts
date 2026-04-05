import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  noExternal: ['@evolving-agent/core'],
  external: ['playwright', 'playwright-core'],
})
