import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In Docker the backend service is called "backend"; natively it's localhost.
const BACKEND = process.env.VITE_BACKEND_HOST || 'localhost'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api':    `http://${BACKEND}:8000`,
      '/health': `http://${BACKEND}:8000`,
    },
  },
})
