import axios from 'axios'

export const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

let ready = null

function configUrl() {
  const base = import.meta.env.BASE_URL || '/'
  return `${base.endsWith('/') ? base : `${base}/`}api-config.json`
}

async function ensureApiBase() {
  if (!ready) {
    ready = (async () => {
      try {
        const response = await fetch(configUrl(), { cache: 'no-store' })
        if (!response.ok) return
        const data = await response.json()
        const apiBase = String(data?.apiBase || '').trim().replace(/\/+$/, '')
        if (apiBase) api.defaults.baseURL = apiBase
      } catch {
        /* keep /api for local Vite proxy */
      }
    })()
  }
  return ready
}

export async function fetchBtOverview(config, nic = 'all') {
  await ensureApiBase()
  return api.post('/bt/overview', { ...config, nic })
}
