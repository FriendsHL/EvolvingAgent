import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: '.',
  build: {
    outDir: 'dist/client',
    emptyDirOnly: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3721',
    },
  },
})
