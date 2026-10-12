import { servers as localServers } from './servers.config.js'

export const STORAGE_KEY = 'aws-query-demo-active-server'

export function createServer(id, name) {
  return {
    id,
    name,
    trafficQuotaGb: '',
    btPanelUrl: '',
    btApiKey: '',
    btIgnoreTls: true,
  }
}

export const emptyConfig = {
  activeServerId: localServers[0]?.id || 's1',
  servers: localServers.map((item) => ({ ...item })),
}

export function hasBtConfig(server) {
  return Boolean(server?.btPanelUrl && server?.btApiKey)
}

export function hasRequiredConfig(config) {
  return hasBtConfig(getActiveServer(config))
}

export function getActiveServer(config) {
  return (
    config?.servers?.find((item) => item.id === config.activeServerId) ||
    config?.servers?.[0] ||
    createServer('s1', '服务器 1')
  )
}

export function loadConfig() {
  const servers = localServers.map((item) => ({ ...item }))
  let activeServerId = servers[0]?.id || 's1'
  try {
    const savedId = localStorage.getItem(STORAGE_KEY)
    if (savedId && servers.some((item) => item.id === savedId)) {
      activeServerId = savedId
    }
  } catch {
    /* ignore */
  }
  return { activeServerId, servers }
}

export function saveActiveServerId(id) {
  localStorage.setItem(STORAGE_KEY, id)
}

export function formatBytes(bytes, digits = 1) {
  if (bytes == null || Number.isNaN(Number(bytes))) return '--'
  const value = Number(bytes)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = Math.abs(value)
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  const rounded = size >= 100 ? size.toFixed(0) : size.toFixed(digits)
  return `${rounded} ${units[unit]}`
}

export function formatRate(bytesPerSec) {
  if (bytesPerSec == null || Number.isNaN(Number(bytesPerSec))) return '--'
  return `${formatBytes(bytesPerSec, 1)}/s`
}

export function formatMb(mb) {
  if (mb == null || Number.isNaN(Number(mb))) return '--'
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Number(mb).toFixed(1)} MB`
}

export function formatGb(gb) {
  if (gb == null || Number.isNaN(Number(gb))) return '--'
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`
  return `${Number(gb).toFixed(1)} GB`
}

export function percentText(value) {
  return formatPercent(value, 0)
}

export function formatPercent(value, digits = 0) {
  if (value == null || Number.isNaN(Number(value))) return '--'
  return `${Number(value).toFixed(digits)}%`
}

export function formatMemMb(mb) {
  if (mb == null || Number.isNaN(Number(mb))) return '--'
  return `${Math.round(Number(mb))} MB`
}
