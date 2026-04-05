import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/server/index.ts'],
  format: ['esm'],
  outDir: 'dist/server',
  target: 'es2022',
  clean: true,
  external: ['@evolving-agent/core'],
})
