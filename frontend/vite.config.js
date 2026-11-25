import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: '../app/manager/public',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('naive-ui') || id.includes('@vicons')) return 'vendor-naive'
          if (id.includes('node_modules/vue')) return 'vendor-vue'
        }
      }
    }
  }
})
