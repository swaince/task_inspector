<script setup lang="ts">
import type { ModuleNode, RepoGraph } from '@/core/engine/profile'
import { computed, onMounted, ref, watch } from 'vue'

/**
 * 模块依赖图。
 *
 * 力导向布局是手写的：节点最多几十个，引一个图形库不划算。
 * 布局只算一次（挂载/换数据时），之后都是纯渲染，交互只做悬停高亮。
 */
const props = defineProps<{ graph: RepoGraph }>()

const WIDTH = 900
const HEIGHT = 460

interface Point { x: number, y: number, vx: number, vy: number }

const points = ref<Record<string, Point>>({})
const hover = ref<string | null>(null)

const nodes = computed(() => props.graph.nodes)
const edges = computed(() => props.graph.edges)

const LAYER_COLOR: Record<ModuleNode['layer'], string> = {
  backend: '#34d399',
  frontend: '#a78bfa',
  mixed: '#fbbf24',
  other: '#94a3b8',
}

const LAYER_LABEL: Record<ModuleNode['layer'], string> = {
  backend: '后端',
  frontend: '前端',
  mixed: '前后端混合',
  other: '其它',
}

function radiusOf(node: ModuleNode) {
  return 5 + Math.min(16, Math.sqrt(node.files) * 1.6)
}

/** 悬停时只高亮与它有边的节点 */
const neighbors = computed(() => {
  const id = hover.value
  if (!id)
    return null
  const set = new Set<string>([id])
  for (const edge of edges.value) {
    if (edge.from === id)
      set.add(edge.to)
    if (edge.to === id)
      set.add(edge.from)
  }
  return set
})

function nodeOpacity(id: string) {
  return neighbors.value && !neighbors.value.has(id) ? 0.18 : 1
}

function edgeOpacity(from: string, to: string, weight: number) {
  if (neighbors.value)
    return from === hover.value || to === hover.value ? 0.9 : 0.05
  return 0.12 + Math.min(0.45, weight / 40)
}

/** 标签只给「有连接、体量不小」的节点，否则图会糊成一片字；节点少时全标 */
function showLabel(node: ModuleNode) {
  if (hover.value === node.id)
    return true
  if (nodes.value.length <= 12)
    return true
  return node.files >= 5 || node.fanIn + node.fanOut >= 3
}

function layout() {
  const list = nodes.value
  if (!list.length) {
    points.value = {}
    return
  }

  const pts: Record<string, Point> = {}
  const ring = Math.min(WIDTH, HEIGHT) * 0.34
  list.forEach((node, i) => {
    const angle = (i / list.length) * Math.PI * 2
    pts[node.id] = {
      x: WIDTH / 2 + Math.cos(angle) * ring,
      y: HEIGHT / 2 + Math.sin(angle) * ring,
      vx: 0,
      vy: 0,
    }
  })

  const ids = list.map(n => n.id)

  for (let tick = 0; tick < 260; tick++) {
    // 节点互斥
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pts[ids[i]]
        const b = pts[ids[j]]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = Math.random() - 0.5
          dy = Math.random() - 0.5
          d2 = 1
        }
        const d = Math.sqrt(d2)
        const force = 1800 / d2
        a.vx += (dx / d) * force
        a.vy += (dy / d) * force
        b.vx -= (dx / d) * force
        b.vy -= (dy / d) * force
      }
    }

    // 依赖边当弹簧：有依赖的模块靠近一些
    for (const edge of edges.value) {
      const a = pts[edge.from]
      const b = pts[edge.to]
      if (!a || !b)
        continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      const force = (d - 110) * 0.012
      a.vx += (dx / d) * force
      a.vy += (dy / d) * force
      b.vx -= (dx / d) * force
      b.vy -= (dy / d) * force
    }

    // 向心 + 阻尼 + 边界
    for (const id of ids) {
      const p = pts[id]
      p.vx += (WIDTH / 2 - p.x) * 0.004
      p.vy += (HEIGHT / 2 - p.y) * 0.004
      p.vx *= 0.82
      p.vy *= 0.82
      p.x = Math.min(WIDTH - 28, Math.max(28, p.x + p.vx))
      p.y = Math.min(HEIGHT - 24, Math.max(24, p.y + p.vy))
    }
  }

  points.value = pts
}

onMounted(layout)
watch(() => props.graph, layout)

const hovered = computed(() => nodes.value.find(n => n.id === hover.value) ?? null)
</script>

<template>
  <div class="space-y-2">
    <div class="relative">
      <svg
        :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
        class="w-full rounded-md border bg-muted/20"
        role="img"
        aria-label="模块依赖图"
      >
        <line
          v-for="edge in edges"
          :key="`${edge.from}->${edge.to}`"
          :x1="points[edge.from]?.x ?? 0"
          :y1="points[edge.from]?.y ?? 0"
          :x2="points[edge.to]?.x ?? 0"
          :y2="points[edge.to]?.y ?? 0"
          stroke="currentColor"
          class="text-muted-foreground"
          :stroke-width="1 + Math.min(3, edge.weight / 8)"
          :stroke-opacity="edgeOpacity(edge.from, edge.to, edge.weight)"
        />

        <g
          v-for="node in nodes"
          :key="node.id"
          :transform="`translate(${points[node.id]?.x ?? 0}, ${points[node.id]?.y ?? 0})`"
          :opacity="nodeOpacity(node.id)"
          class="cursor-default"
          @mouseenter="hover = node.id"
          @mouseleave="hover = null"
        >
          <circle
            :r="radiusOf(node)"
            :fill="LAYER_COLOR[node.layer]"
            fill-opacity="0.85"
            stroke="currentColor"
            class="text-background"
            stroke-width="1.5"
          />
          <text
            v-if="showLabel(node)"
            y="-10"
            text-anchor="middle"
            class="fill-foreground text-[10px]"
          >{{ node.id }}</text>
        </g>
      </svg>

      <div
        v-if="hovered"
        class="pointer-events-none absolute top-2 right-2 rounded-md border bg-popover px-2.5 py-1.5 text-[11px] shadow-sm"
      >
        <div class="font-medium">{{ hovered.id }}</div>
        <div class="text-muted-foreground">
          {{ hovered.files }} 个文件 · 被依赖 {{ hovered.fanIn }} · 依赖 {{ hovered.fanOut }}
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <span v-for="(label, layer) in LAYER_LABEL" :key="layer" class="inline-flex items-center gap-1">
        <span class="inline-block size-2 rounded-full" :style="{ background: LAYER_COLOR[layer] }" />
        {{ label }}
      </span>
      <span class="ml-auto">节点大小 = 文件数；连线 = import 依赖，越粗越频繁</span>
    </div>
  </div>
</template>
