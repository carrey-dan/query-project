<template>
  <div class="app-shell">
    <nav class="server-tabs" aria-label="目标服务器">
      <button
        v-for="server in config.servers"
        :key="server.id"
        class="server-tab"
        :class="{ active: server.id === config.activeServerId, ready: hasBtConfig(server) }"
        @click="selectServer(server.id)"
      >
        {{ server.name }}
      </button>
    </nav>

    <header class="topbar">
      <div>
        <h1>{{ activeServer.name || '服务器监控' }}</h1>
        <div class="meta" v-if="overview">
          <span class="badge">
            <span class="dot" :class="overview.instance.state"></span>
            {{ overview.instance.name }} · {{ overview.source === 'bt' ? '宝塔' : overview.instance.state }}
          </span>
          <span>{{ overview.instance.type }}</span>
          <span v-if="overview.instance.launchTime">运行 {{ overview.instance.launchTime }}</span>
        </div>
        <div class="meta" v-else></div>
      </div>
      <div class="actions">
        <button class="btn primary" :disabled="loading" @click="refresh">
          {{ loading ? '查询中...' : '刷新数据' }}
        </button>
      </div>
    </header>

    <div v-if="error" class="notice error">{{ error }}</div>
    <div v-else-if="overview?.notice" class="notice">{{ overview.notice }}</div>

    <div class="cards">
      <MetricCard label="负载" :value="loadLabel" :percent="cards.load?.percent" :detail="loadDetail" />
      <MetricCard
        label="CPU"
        :value="cards.cpu?.cores ? `${cards.cpu.cores}核心` : '--'"
        :percent="cards.cpu?.percent"
        :detail="cpuDetail"
      />
      <MetricCard
        label="内存"
        :used="memoryUsed"
        :total="memoryTotal"
        :percent="cards.memory?.percent"
        :hint="memoryHint"
        align="end"
        :detail="memoryDetail"
      />
      <MetricCard
        :label="cards.disk?.mount || '/'"
        :used="diskUsed"
        :total="diskTotal"
        :percent="cards.disk?.percent"
        :hint="diskHint"
        align="end"
        :detail="diskDetail"
      />
    </div>

    <div class="cards">
      <MetricCard
        label="网络"
        :value="networkValue"
        :percent="networkPercent"
        hint="实时吞吐（上行 / 下行）"
      />
      <MetricCard
        label="流量"
        :used="trafficUsed"
        :total="trafficQuota"
        :percent="trafficPercent"
        hint="累计发送 + 接收"
      />
      <article class="instance-card span-2">
        <div class="metric-label">系统信息</div>
        <div class="metric-value" style="font-size: 16px; font-weight: 600">
          {{ overview?.instance.id || activeServer.btPanelUrl || '请填写当前服务器的宝塔地址' }}
        </div>
        <div class="metric-sub">仅轮询当前 Tab，切换时会停止上一台的请求</div>
      </article>
    </div>

    <TrafficPanel
      v-model:tab="chartTab"
      v-model:nic="nic"
      :nics="overview?.instance.nics || []"
      :current-up="series.currentUp"
      :current-down="series.currentDown"
      :total-up="series.totalUp"
      :total-down="series.totalDown"
      :series="series.series"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MetricCard from './components/MetricCard.vue'
import TrafficPanel from './components/TrafficPanel.vue'
import { fetchBtOverview } from './api.js'
import {
  formatBytes,
  formatGb,
  formatMb,
  formatMemMb,
  formatPercent,
  getActiveServer,
  hasBtConfig,
  loadConfig,
  saveActiveServerId,
} from './format.js'

const MAX_POINTS = 72
const POLL_MS = 4000
const emptySeries = () => ({
  currentUp: 0,
  currentDown: 0,
  totalUp: 0,
  totalDown: 0,
  series: { up: [], down: [] },
})

const config = ref(loadConfig())
const loading = ref(false)
const error = ref('')
const overview = ref(null)
const chartTab = ref('traffic')
const nic = ref('all')
const series = ref(emptySeries())

let pollTimer = 0
let pollToken = 0

const activeServer = computed(() => getActiveServer(config.value))

const cards = computed(() => overview.value?.cards || {})
const loadLabel = computed(() => cards.value.load?.label || '--')
const memoryUsed = computed(() => (cards.value.memory?.usedMb != null ? formatMb(cards.value.memory.usedMb) : ''))
const memoryTotal = computed(() => (cards.value.memory?.totalMb ? formatMb(cards.value.memory.totalMb) : ''))
const memoryHint = computed(() =>
  cards.value.memory?.usedMb == null ? '用量来自宝塔 GetNetWork' : '',
)
const diskUsed = computed(() => (cards.value.disk?.usedGb != null ? formatGb(cards.value.disk.usedGb) : ''))
const diskTotal = computed(() => (cards.value.disk?.totalGb ? formatGb(cards.value.disk.totalGb) : ''))
const diskHint = computed(() =>
  cards.value.disk?.usedGb == null ? '用量来自宝塔 GetNetWork' : '',
)
const networkValue = computed(() => {
  const net = cards.value.network || {}
  const up = net.upBytesPerSec ?? 0
  const down = net.downBytesPerSec ?? 0
  return `${formatBytes(up)} / ${formatBytes(down)}`
})
const networkPercent = computed(() => {
  const net = cards.value.network || {}
  const mbps = ((Number(net.upBytesPerSec || 0) + Number(net.downBytesPerSec || 0)) * 8) / 1_000_000
  return Math.min(100, mbps)
})
const trafficUsed = computed(() => formatBytes(cards.value.traffic?.totalBytes || 0))
const trafficQuota = computed(() =>
  cards.value.traffic?.quotaBytes ? formatBytes(cards.value.traffic.quotaBytes) : '',
)
const trafficPercent = computed(() => {
  const total = cards.value.traffic?.totalBytes || 0
  const quota = cards.value.traffic?.quotaBytes || 0
  if (!quota) return total ? 5 : 0
  return Math.min(100, (total / quota) * 100)
})

function loadAvgText(value) {
  return Number(value || 0).toFixed(2)
}

const loadDetail = computed(() => {
  const load = cards.value.load
  if (!overview.value || !load) return null
  const rows = [
    {
      label: '最近1/5/15分钟平均负载：',
      value: `${loadAvgText(load.one)} / ${loadAvgText(load.five)} / ${loadAvgText(load.fifteen)}`,
    },
  ]
  if (load.activeProcesses != null && load.totalProcesses != null) {
    rows.push({
      label: '活动进程数 / 总进程数：',
      value: `${load.activeProcesses} / ${load.totalProcesses}`,
    })
  }
  return {
    prefix: '检测到当前负载',
    badge: `运行达到${formatPercent(load.percent, 0)}`,
    section: '基础信息',
    rows,
  }
})

const cpuDetail = computed(() => {
  const cpu = cards.value.cpu
  if (!overview.value || !cpu) return null
  const physicalCpus = cpu.physicalCpus ?? 1
  const physicalCores = cpu.physicalCores ?? cpu.cores ?? '--'
  const logicalCores = cpu.logicalCores ?? cpu.cores ?? '--'
  const model = cpu.model || '未知处理器'
  return {
    prefix: '检测到当前CPU使用率',
    badge: `占用${formatPercent(cpu.percent, 0)}`,
    section: '基础信息',
    rows: [
      { value: `${model} * ${physicalCpus}` },
      { value: `${physicalCpus}个物理CPU，${physicalCores}个物理核心，${logicalCores}个逻辑核心` },
    ],
  }
})

const memoryDetail = computed(() => {
  const mem = cards.value.memory
  if (!overview.value || !mem) return null
  const rows = [
    { label: '空闲内存：', value: formatMemMb(mem.freeMb) },
    { label: '已用：', value: formatMemMb(mem.usedMb) },
    { label: '总内存：', value: formatMemMb(mem.totalMb) },
    { label: '共享：', value: formatMemMb(mem.sharedMb) },
    { label: '可分配内存：', value: formatMemMb(mem.availableMb) },
    {
      label: 'buff/cache：',
      value:
        mem.buffersMb != null || mem.cachedMb != null
          ? `${Math.round(Number(mem.cachedMb || 0))}/${Math.round(Number(mem.buffersMb || 0))}`
          : '--',
    },
  ]
  return {
    prefix: '检测到当前内存',
    badge: `占用${formatPercent(mem.percent, 0)}`,
    section: '内存信息',
    columns: 2,
    rows,
  }
})

const diskDetail = computed(() => {
  const disk = cards.value.disk
  if (!overview.value || !disk) return null
  const mount = disk.mount || '/'
  return {
    prefix: '检测到当前磁盘',
    badge: `容量占用${formatPercent(disk.percent, 2)}`,
    section: '基础信息',
    rows: [
      { label: '挂载点：', value: `${mount} (${mount})` },
      {
        value: `共: ${formatGb(disk.totalGb)}, 可用: ${formatGb(disk.availableGb)}, 已用: ${formatGb(disk.usedGb)}`,
      },
      { label: '文件系统：', value: disk.filesystem || '--' },
      {
        value: `类型: ${disk.type || '--'}, 系统占用: ${formatPercent(disk.percent, 2)}`,
      },
    ],
  }
})

watch(chartTab, () => {
  if (hasBtConfig(activeServer.value) && overview.value?.source === 'bt') {
    series.value = emptySeries()
    appendBtPoint(overview.value)
  }
})

watch(nic, () => {
  if (hasBtConfig(activeServer.value) && overview.value?.source === 'bt') {
    refreshBt(false, pollToken)
  }
})

function payload() {
  const server = activeServer.value
  return {
    ...server,
    trafficQuotaGb: Number(server.trafficQuotaGb || 0),
    nic: nic.value,
  }
}

function appendBtPoint(data) {
  const snap = data.snapshot || {}
  const isDisk = chartTab.value === 'disk'
  const upValue = isDisk ? snap.writeBytesPerSec || 0 : snap.upBytesPerSec || 0
  const downValue = isDisk ? snap.readBytesPerSec || 0 : snap.downBytesPerSec || 0
  const pointTime = snap.time || new Date().toISOString()
  const nextUp = [...(series.value.series.up || []), { time: pointTime, value: upValue }].slice(-MAX_POINTS)
  const nextDown = [...(series.value.series.down || []), { time: pointTime, value: downValue }].slice(-MAX_POINTS)
  series.value = {
    currentUp: upValue,
    currentDown: downValue,
    totalUp: isDisk ? 0 : snap.upTotal || data.cards?.traffic?.sentBytes || 0,
    totalDown: isDisk ? 0 : snap.downTotal || data.cards?.traffic?.receivedBytes || 0,
    series: { up: nextUp, down: nextDown },
  }
}

function stopPoll() {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = 0
  }
}

function startBtPoll(token) {
  stopPoll()
  pollTimer = window.setInterval(() => {
    if (token !== pollToken) {
      stopPoll()
      return
    }
    refreshBt(false, token)
  }, POLL_MS)
}

function isStale(token, serverId) {
  return token !== pollToken || config.value.activeServerId !== serverId
}

async function refreshBt(resetSeries = true, token = pollToken) {
  const serverId = config.value.activeServerId
  const overviewRes = await fetchBtOverview(payload(), nic.value)
  if (isStale(token, serverId)) return
  const data = overviewRes.data.data
  overview.value = data
  if (resetSeries) series.value = emptySeries()
  appendBtPoint(data)
}

async function refresh() {
  const token = ++pollToken
  const serverId = config.value.activeServerId
  error.value = ''
  if (!hasBtConfig(activeServer.value)) {
    error.value = `请在 src/servers.config.js 中配置「${activeServer.value.name}」的面板地址和 API 密钥`
    stopPoll()
    return
  }
  loading.value = true
  stopPoll()
  try {
    await refreshBt(true, token)
    if (isStale(token, serverId)) return
    startBtPoll(token)
  } catch (err) {
    if (isStale(token, serverId)) return
    error.value = err.response?.data?.message || err.message || '查询失败'
  } finally {
    if (!isStale(token, serverId)) loading.value = false
  }
}

function selectServer(id) {
  if (id === config.value.activeServerId) return
  pollToken += 1
  stopPoll()
  overview.value = null
  series.value = emptySeries()
  error.value = ''
  nic.value = 'all'
  config.value = { ...config.value, activeServerId: id }
  saveActiveServerId(id)
  refresh()
}

onMounted(() => {
  refresh()
})

onBeforeUnmount(() => {
  pollToken += 1
  stopPoll()
})
</script>
