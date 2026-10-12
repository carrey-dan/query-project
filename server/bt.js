import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import axios from 'axios'

function md5(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex')
}

function signBt(apiKey) {
  const requestTime = String(Math.floor(Date.now() / 1000))
  const requestToken = md5(requestTime + md5(apiKey))
  return { request_time: requestTime, request_token: requestToken }
}

function parseBtSize(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value).trim()
  const match = text.match(/^([\d.]+)\s*([KMGT])I?B?$/i)
  if (match) {
    const amount = Number(match[1])
    const unit = match[2].toUpperCase()
    const factor = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
    return amount * (factor[unit] || 1)
  }
  const percent = text.match(/^([\d.]+)\s*%$/)
  if (percent) return Number(percent[1])
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : null
}

function pickRootDisk(disks) {
  const list = Array.isArray(disks) ? disks : []
  return list.find((item) => (item.path || item.Path) === '/') || list[0] || null
}

function parseDisk(disk) {
  if (!disk) {
    return {
      mount: '/',
      usedGb: null,
      totalGb: null,
      availableGb: null,
      percent: null,
      filesystem: '',
      type: '',
    }
  }
  const mount = disk.path || disk.Path || '/'
  const size = disk.size || disk.Size || []
  const bytes = disk.byte_size || disk.byteSize || []
  const totalBytes = Number(bytes[0]) || parseBtSize(size[0])
  const usedBytes = Number(bytes[1]) || parseBtSize(size[1])
  const availableBytes = Number(bytes[2]) || parseBtSize(size[2])
  let percent = parseBtSize(size[3])
  if (percent != null && percent <= 1 && usedBytes && totalBytes) {
    percent = (usedBytes / totalBytes) * 100
  }
  if (percent == null && usedBytes && totalBytes) {
    percent = (usedBytes / totalBytes) * 100
  }
  return {
    mount,
    usedGb: usedBytes != null ? usedBytes / 1024 ** 3 : null,
    totalGb: totalBytes != null ? totalBytes / 1024 ** 3 : null,
    availableGb: availableBytes != null ? availableBytes / 1024 ** 3 : null,
    percent,
    filesystem: disk.filesystem || disk.Filesystem || '',
    type: disk.type || disk.Type || '',
  }
}

function loadStatus(percent) {
  if (percent == null) return '暂无数据'
  if (percent < 40) return '运行流畅'
  if (percent < 70) return '负载正常'
  if (percent < 90) return '负载偏高'
  return '负载过高'
}

function requireBtConfig(body = {}) {
  const panelUrl = String(body.btPanelUrl || process.env.BT_PANEL_URL || '').trim().replace(/\/+$/, '')
  const apiKey = String(body.btApiKey || process.env.BT_API_KEY || '').trim()
  const ignoreTls = Boolean(body.btIgnoreTls ?? process.env.BT_IGNORE_TLS === '1')
  const trafficQuotaGb = Number(body.trafficQuotaGb || process.env.TRAFFIC_QUOTA_GB || 0)
  const nic = String(body.nic || 'all')

  if (!panelUrl || !apiKey) {
    const error = new Error('请先填写宝塔面板地址和 API 密钥')
    error.status = 400
    throw error
  }

  return {
    panelUrl,
    apiKey,
    ignoreTls,
    trafficQuotaGb: Number.isFinite(trafficQuotaGb) ? trafficQuotaGb : 0,
    nic,
  }
}

function panelBases(panelUrl) {
  const raw = panelUrl.includes('://') ? panelUrl : `http://${panelUrl}`
  const parsed = new URL(raw)
  const origin = `${parsed.protocol}//${parsed.host}`
  const pathPrefix = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : ''
  const flippedOrigin = origin.startsWith('https://')
    ? `http://${parsed.host}`
    : `https://${parsed.host}`
  return [...new Set([origin + pathPrefix, origin, flippedOrigin + pathPrefix, flippedOrigin].filter(Boolean))]
}

function connectHint(code, url) {
  return `连接被重置（${code || 'ECONNRESET'}，目标 ${url}）。常见原因：1) 协议不对，浏览器能打开的是 http 就不要填 https（或反过来）；2) 面板开了 SSL 自签证书，请勾选「忽略自签证书」；3) 安全组未放行面板端口，或 API 白名单没有本机公网 IP。已自动尝试切换 http/https 和 IPv4。`
}

function isResetError(error) {
  const code = error.code || error.cause?.code || error.cause?.cause?.code
  return ['ECONNRESET', 'EPROTO', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED', 'ERR_SSL_WRONG_VERSION_NUMBER', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)
}

async function postBt(baseUrl, apiKey, pathname, ignoreTls) {
  const url = `${baseUrl}${pathname}`
  const form = new URLSearchParams({
    ...signBt(apiKey),
    action: 'GetNetWork',
  })
  const httpAgent = new http.Agent({ family: 4, keepAlive: false })
  const httpsAgent = new https.Agent({
    family: 4,
    keepAlive: false,
    rejectUnauthorized: !ignoreTls,
    minVersion: 'TLSv1',
  })
  return axios.post(url, form.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
    timeout: 8000,
    httpAgent,
    httpsAgent,
    validateStatus: () => true,
    transformRequest: [(data) => data],
    maxRedirects: 0,
  })
}

function parseBtPayload(response) {
  const data = response.data
  if (typeof data === 'string' && /<html/i.test(data)) {
    throw Object.assign(new Error(`HTTP ${response.status}：返回了登录页而不是 JSON。请把安全入口写进面板地址，并把本机公网 IP 加入 API 白名单。`), { retryable: true })
  }
  let payload = data
  if (typeof data === 'string') {
    payload = JSON.parse(data)
  }
  if (payload && payload.status === false) {
    throw Object.assign(new Error(payload.msg || '宝塔拒绝了请求（常见原因：IP 未加入 API 白名单）'), { retryable: true })
  }
  if (response.status >= 400) {
    throw Object.assign(new Error(`宝塔 HTTP ${response.status}`), { retryable: true })
  }
  if (payload && (payload.mem || payload.cpu || payload.disk)) {
    return payload
  }
  throw Object.assign(new Error('宝塔返回数据不完整'), { retryable: true })
}

export async function fetchBtNetwork(config) {
  const bases = panelBases(config.panelUrl)
  const paths = ['/system?action=GetNetWork', '/v2/system?action=GetNetWork']
  const tlsFlags = config.ignoreTls ? [true] : [false, true]
  let lastError = '宝塔接口无响应'

  for (const base of bases) {
    let skipBase = false
    for (const ignoreTls of tlsFlags) {
      if (skipBase) break
      for (const path of paths) {
        try {
          const response = await postBt(base, config.apiKey, path, ignoreTls)
          return parseBtPayload(response)
        } catch (error) {
          if (isResetError(error)) {
            lastError = connectHint(error.code || error.cause?.code, `${base}${path}`)
            skipBase = true
            break
          }
          lastError = error.message || lastError
          if (error.retryable) continue
          if (error.name === 'SyntaxError') {
            lastError = `无法解析宝塔响应：${error.message}`
            continue
          }
        }
      }
    }
  }

  const error = new Error(lastError)
  error.status = 502
  throw error
}

export function mapBtOverview(raw, config) {
  const cpu = Array.isArray(raw.cpu) ? raw.cpu : []
  const cpuPercent = Number(cpu[0] ?? raw.cpu?.used ?? 0)
  const logicalCores = Number(cpu[1] ?? raw.cpu?.cpu_count ?? 0) || null
  let physicalCores = Number(cpu[4] ?? logicalCores) || null
  let physicalCpus = Number(cpu[5] ?? 1) || 1
  let cpuModel = String(cpu[3] || '').trim()
  const modelCount = cpuModel.match(/^(.*?)\s*\*\s*(\d+)\s*$/)
  if (modelCount) {
    cpuModel = modelCount[1].trim()
    if (!Number(cpu[5])) physicalCpus = Number(modelCount[2]) || physicalCpus
  }
  const cpuTimes = raw.cpu_times || raw.cpuTimes || {}
  const activeRaw = cpu[6] ?? cpuTimes.active_processes ?? cpuTimes['活动进程数']
  const totalRaw = cpu[7] ?? cpuTimes.total_processes ?? cpuTimes['总进程数']
  const activeProcesses = Number.isFinite(Number(activeRaw)) ? Number(activeRaw) : null
  const totalProcesses = Number.isFinite(Number(totalRaw)) ? Number(totalRaw) : null
  const cores = logicalCores
  const mem = raw.mem || {}
  const memUsedMb = Number(mem.memRealUsed ?? mem.memUsed ?? 0)
  const memTotalMb = Number(mem.memTotal ?? 0)
  const memFreeMb = Number(mem.memFree ?? 0)
  const memAvailableMb =
    mem.memAvailable != null && mem.memAvailable !== ''
      ? Number(mem.memAvailable)
      : memTotalMb
        ? Math.max(0, memTotalMb - memUsedMb)
        : null
  const memSharedMb =
    mem.memShared != null || mem.shared != null ? Number(mem.memShared ?? mem.shared) : null
  const memBuffersMb =
    mem.memBuffers != null || mem.memBuffer != null ? Number(mem.memBuffers ?? mem.memBuffer) : null
  const memCachedMb = mem.memCached != null && mem.memCached !== '' ? Number(mem.memCached) : null
  const disk = parseDisk(pickRootDisk(raw.disk))
  const loadOne = Number(raw.load?.one ?? 0)
  const loadFive = Number(raw.load?.five ?? 0)
  const loadFifteen = Number(raw.load?.fifteen ?? 0)
  const loadPercent =
    cores && loadOne
      ? Math.min(100, (loadOne / cores) * 100)
      : cpuPercent
  const networkMap = raw.network && typeof raw.network === 'object' ? raw.network : {}
  const nics = Object.keys(networkMap).map((name) => ({ id: name, name }))
  const selected = config.nic && config.nic !== 'all' ? networkMap[config.nic] : null
  const upKbs = Number(selected?.up ?? raw.up ?? 0)
  const downKbs = Number(selected?.down ?? raw.down ?? 0)
  const upTotal = Number(selected?.upTotal ?? raw.upTotal ?? 0)
  const downTotal = Number(selected?.downTotal ?? raw.downTotal ?? 0)
  const readKbs = Number(raw.iostat?.read ?? raw.io?.read ?? 0)
  const writeKbs = Number(raw.iostat?.write ?? raw.io?.write ?? 0)
  const quotaBytes = config.trafficQuotaGb > 0 ? config.trafficQuotaGb * 1024 ** 3 : 0
  const memPercent = memTotalMb ? (memUsedMb / memTotalMb) * 100 : null

  return {
    source: 'bt',
    notice: null,
    instance: {
      id: raw.system || '宝塔面板',
      name: raw.system || '宝塔',
      type: cores ? `${cores} 核` : '',
      state: 'running',
      az: '',
      publicIp: '',
      privateIp: '',
      vpcId: '',
      launchTime: raw.time || '',
      vcpus: cores,
      memoryTotalMb: memTotalMb,
      diskTotalGb: disk.totalGb,
      rootDevice: disk.mount,
      nics,
      agentInstalled: true,
      guestSource: 'bt',
    },
    cards: {
      load: {
        percent: loadPercent,
        label: loadStatus(loadPercent),
        one: loadOne,
        five: loadFive,
        fifteen: loadFifteen,
        activeProcesses,
        totalProcesses,
      },
      cpu: {
        percent: cpuPercent,
        cores,
        model: cpuModel,
        physicalCpus,
        physicalCores,
        logicalCores,
      },
      memory: {
        percent: memPercent,
        usedMb: memUsedMb,
        totalMb: memTotalMb,
        freeMb: memFreeMb,
        availableMb: memAvailableMb,
        sharedMb: memSharedMb,
        buffersMb: memBuffersMb,
        cachedMb: memCachedMb,
      },
      disk: {
        percent: disk.percent,
        usedGb: disk.usedGb,
        totalGb: disk.totalGb,
        availableGb: disk.availableGb,
        mount: disk.mount,
        filesystem: disk.filesystem,
        type: disk.type,
      },
      network: {
        upBytesPerSec: upKbs * 1024,
        downBytesPerSec: downKbs * 1024,
        upBytesPerPeriod: upKbs * 1024,
        downBytesPerPeriod: downKbs * 1024,
        periodSeconds: 1,
      },
      traffic: {
        sentBytes: upTotal,
        receivedBytes: downTotal,
        totalBytes: upTotal + downTotal,
        quotaBytes,
      },
    },
    io: {
      writeBytesPerSec: writeKbs * 1024,
      readBytesPerSec: readKbs * 1024,
    },
    snapshot: {
      time: new Date().toISOString(),
      upBytesPerSec: upKbs * 1024,
      downBytesPerSec: downKbs * 1024,
      writeBytesPerSec: writeKbs * 1024,
      readBytesPerSec: readKbs * 1024,
      upTotal,
      downTotal,
    },
  }
}

export { requireBtConfig }
