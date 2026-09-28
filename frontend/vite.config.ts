import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/transcribe': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})