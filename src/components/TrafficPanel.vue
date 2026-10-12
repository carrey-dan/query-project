<template>
  <section class="panel">
    <div class="panel-head">
      <div class="tabs">
        <button class="tab" :class="{ active: tab === 'traffic' }" @click="$emit('update:tab', 'traffic')">流量</button>
        <button class="tab" :class="{ active: tab === 'disk' }" @click="$emit('update:tab', 'disk')">磁盘IO</button>
      </div>
      <label class="nic-filter">
        网卡
        <select :value="nic" @change="$emit('update:nic', $event.target.value)">
          <option value="all">所有</option>
          <option v-for="item in nics" :key="item.id" :value="item.id">
            {{ item.name || item.id }}
          </option>
        </select>
      </label>
    </div>

    <div class="stat-row">
      <div class="stat">
        <div class="stat-label"><span class="dot running"></span>{{ tab === 'traffic' ? '上行' : '写入' }}</div>
        <div class="stat-value">{{ formatBytes(currentUp) }}</div>
      </div>
      <div class="stat">
        <div class="stat-label"><span class="dot stopped"></span>{{ tab === 'traffic' ? '下行' : '读取' }}</div>
        <div class="stat-value">{{ formatBytes(currentDown) }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">{{ tab === 'traffic' ? '总发送' : '总写入' }}</div>
        <div class="stat-value">{{ formatBytes(totalUp) }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">{{ tab === 'traffic' ? '总接收' : '总读取' }}</div>
        <div class="stat-value">{{ formatBytes(totalDown) }}</div>
      </div>
    </div>

    <div ref="chartEl" class="chart"></div>
  </section>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { formatBytes } from '../format.js'

const props = defineProps({
  tab: { type: String, default: 'traffic' },
  nic: { type: String, default: 'all' },
  nics: { type: Array, default: () => [] },
  currentUp: { type: Number, default: 0 },
  currentDown: { type: Number, default: 0 },
  totalUp: { type: Number, default: 0 },
  totalDown: { type: Number, default: 0 },
  series: { type: Object, default: () => ({ up: [], down: [] }) },
})

defineEmits(['update:tab', 'update:nic'])

const chartEl = ref(null)
let chart

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatTime(value) {
  const date = new Date(value)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function render() {
  if (!chart) return
  const up = props.series.up || []
  const down = props.series.down || []
  const times = (up.length >= down.length ? up : down).map((item) => formatTime(item.time))
  const upMap = Object.fromEntries(up.map((item) => [formatTime(item.time), item.value]))
  const downMap = Object.fromEntries(down.map((item) => [formatTime(item.time), item.value]))
  const upValues = times.map((time) => upMap[time] ?? 0)
  const downValues = times.map((time) => downMap[time] ?? 0)
  const maxValue = Math.max(1, ...upValues, ...downValues)
  const upLabel = props.tab === 'traffic' ? '上行' : '写入'
  const downLabel = props.tab === 'traffic' ? '下行' : '读取'

  chart.setOption({
    grid: { left: 56, right: 24, top: 24, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: '#eee',
      textStyle: { color: '#111827' },
      formatter(params) {
        const time = params[0]?.axisValue || ''
        const lines = params
          .map((item) => {
            const color = item.seriesName === upLabel ? '#22c55e' : '#f97316'
            return `<div style="display:flex;gap:8px;align-items:center;margin-top:6px">
              <span style="width:8px;height:8px;border-radius:50%;background:${color}"></span>
              ${item.seriesName}: ${formatBytes(item.data)}/s
            </div>`
          })
          .join('')
        return `时间: ${time}${lines}`
      },
    },
    xAxis: {
      type: 'category',
      data: times,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisLabel: { color: '#9ca3af' },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: Math.ceil(maxValue * 1.2) || 1,
      splitLine: { lineStyle: { color: '#f3f4f6' } },
      axisLabel: {
        color: '#9ca3af',
        formatter: (value) => (value >= 1000 ? `${Math.round(value / 1000)}k` : value),
      },
    },
    series: [
      {
        name: upLabel,
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: upValues,
        color: '#22c55e',
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(34,197,94,0.28)' },
            { offset: 1, color: 'rgba(34,197,94,0.02)' },
          ]),
        },
      },
      {
        name: downLabel,
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: downValues,
        color: '#f97316',
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(249,115,22,0.18)' },
            { offset: 1, color: 'rgba(249,115,22,0.02)' },
          ]),
        },
      },
    ],
  })
}

onMounted(() => {
  chart = echarts.init(chartEl.value)
  render()
  window.addEventListener('resize', resize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  chart?.dispose()
})

function resize() {
  chart?.resize()
}

watch(
  () => [props.series, props.tab],
  () => render(),
  { deep: true },
)
</script>
