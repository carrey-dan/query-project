<template>
  <div class="donut" aria-hidden="true">
    <svg viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="52" fill="none" stroke="#eef1f4" stroke-width="8" />
      <circle
        cx="60"
        cy="60"
        r="52"
        fill="none"
        :stroke="color"
        stroke-width="8"
        stroke-linecap="round"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="offset"
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="66" text-anchor="middle" :fill="color" font-size="28" font-weight="700">
        {{ display }}
      </text>
    </svg>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { percentText } from '../format.js'

const props = defineProps({
  percent: { type: [Number, String], default: null },
  color: { type: String, default: '#22c55e' },
})

const radius = 52
const circumference = 2 * Math.PI * radius
const safePercent = computed(() => {
  const value = Number(props.percent)
  if (Number.isNaN(value) || value == null) return 0
  return Math.max(0, Math.min(100, value))
})
const offset = computed(() => circumference - (safePercent.value / 100) * circumference)
const display = computed(() => (props.percent == null ? '--' : percentText(props.percent).replace('%', '') + '%'))
</script>
