<template>
  <article
    class="metric-card"
    :class="{ 'has-detail': Boolean(detail) }"
    :tabindex="detail ? 0 : undefined"
    @mouseenter="open = true"
    @mouseleave="open = false"
    @focusin="open = true"
    @focusout="onFocusOut"
    @click="onToggle"
  >
    <div class="metric-copy">
      <div class="metric-label">{{ label }}</div>
      <div class="metric-value">
        <span v-if="used" class="used">{{ used }}</span>
        <span v-if="total"> / {{ total }}</span>
        <span v-if="!used && !total">{{ value }}</span>
      </div>
      <div v-if="hint" class="metric-sub">{{ hint }}</div>
    </div>
    <DonutGauge :percent="percent" />

    <div v-if="detail && open" class="detail-pop" :class="{ 'is-end': align === 'end' }" role="tooltip">
      <div class="detail-inner">
        <div class="detail-head">
          <span>{{ detail.prefix }}</span>
          <span v-if="detail.badge" class="detail-badge">{{ detail.badge }}</span>
        </div>
        <div class="detail-section">{{ detail.section || '基础信息' }}</div>
        <div class="detail-grid" :class="{ 'is-two': detail.columns === 2 }">
          <div
            v-for="(row, index) in detail.rows"
            :key="`${row.label || row.value}-${index}`"
            class="detail-row"
            :class="{ span2: row.span2 || detail.columns !== 2 }"
          >
            <span v-if="row.label" class="detail-k">{{ row.label }}</span>
            <span class="detail-v">{{ row.value }}</span>
          </div>
        </div>
      </div>
    </div>
  </article>
</template>

<script setup>
import { ref } from 'vue'
import DonutGauge from './DonutGauge.vue'

defineProps({
  label: { type: String, required: true },
  value: { type: String, default: '--' },
  used: { type: String, default: '' },
  total: { type: String, default: '' },
  percent: { type: [Number, String], default: null },
  hint: { type: String, default: '' },
  detail: { type: Object, default: null },
  align: { type: String, default: 'start' },
})

const open = ref(false)

function onFocusOut(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    open.value = false
  }
}

function onToggle() {
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
  open.value = !open.value
}
</script>
