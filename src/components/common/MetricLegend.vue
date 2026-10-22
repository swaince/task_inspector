<script setup lang="ts">
/**
 * 指标说明。
 *
 * 统计口径是这类页面的信任基础：同一个词（比如「申报工时」）在不同维度下
 * 分母不同，不写清楚就会被当成另一个意思。统一放在表格底部，按「指标 → 含义」排。
 */
defineProps<{
  title?: string
  items: Array<{ label: string, desc: string }>
}>()
</script>

<template>
  <div class="mt-3 rounded-md border border-dashed bg-muted/20 px-3 py-2.5">
    <div v-if="title" class="mb-1.5 text-[11px] font-medium text-muted-foreground">
      {{ title }}
    </div>
    <dl class="grid gap-x-6 gap-y-1 text-[11px] leading-relaxed sm:grid-cols-2">
      <div v-for="item in items" :key="item.label" class="flex gap-1.5">
        <dt class="shrink-0 text-foreground/80">{{ item.label }}</dt>
        <dd class="text-muted-foreground">
          {{ item.desc }}
        </dd>
      </div>
    </dl>
  </div>
</template>
