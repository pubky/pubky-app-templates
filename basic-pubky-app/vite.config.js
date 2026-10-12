import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        app: resolve(import.meta.dirname, 'index.html'),
        reader: resolve(import.meta.dirname, 'public-reader.html'),
      },
    },
  },
})
