#!/usr/bin/env node
/**
 * 从 git 提交生成发布说明（changelog）。
 *
 * 发布流水线在 publish 作业里调用：
 *
 *   node tools/changelog.mjs --version 0.3.2 --out changelog.md
 *
 * 默认从「当前版本之前最近的版本 tag」统计到 HEAD；--from/--to 可以手工指定。
 * 输出是 Markdown，既写进 latest.json 的 notes（应用内更新弹窗展示），
 * 也拼进 GitHub Release 的正文。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim()
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value).trim())
  return match ? match.slice(1, 4).map(Number) : null
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i])
      return a[i] - b[i]
  }
  return 0
}

function isAncestor(tag, to) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', tag, to], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}

function sameCommit(tag, to) {
  try {
    return git(['rev-parse', `${tag}^{commit}`]) === git(['rev-parse', `${to}^{commit}`])
  }
  catch {
    return false
  }
}

/** 找当前版本之前最近的版本 tag：版本号更小、指向 HEAD 祖先、且不是 HEAD 自己 */
function previousTag(version, to) {
  const current = version ? parseVersion(version) : null
  const tags = git(['tag', '--list', 'v[0-9]*'])
    .split(/\r?\n/)
    .filter(Boolean)
    .map(tag => ({ tag, version: parseVersion(tag) }))
    .filter(item => item.version)
    .sort((a, b) => compareVersion(b.version, a.version))

  for (const item of tags) {
    if (current && compareVersion(item.version, current) >= 0)
      continue
    if (!isAncestor(item.tag, to))
      continue
    // 没传版本时，不要拿 HEAD 自己的 tag 当起点，否则区间为空
    if (!current && sameCommit(item.tag, to))
      continue
    return item.tag
  }
  return ''
}

const SECTIONS = [
  { key: 'breaking', title: '不兼容变更' },
  { key: 'feat', title: '新功能' },
  { key: 'fix', title: '问题修复' },
  { key: 'perf', title: '性能优化' },
  { key: 'refactor', title: '重构' },
  { key: 'docs', title: '文档' },
  { key: 'other', title: '其他改动' },
]

const TYPE_SECTION = {
  feat: 'feat',
  fix: 'fix',
  perf: 'perf',
  refactor: 'refactor',
  docs: 'docs',
  build: 'other',
  chore: 'other',
  ci: 'other',
  test: 'other',
  style: 'other',
  revert: 'other',
}

const CONVENTIONAL = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/i

function classify(subject) {
  const match = CONVENTIONAL.exec(subject)
  if (!match)
    return { section: 'other', desc: subject.trim() }

  const type = match[1].toLowerCase()
  const breaking = Boolean(match[3])
  const desc = match[4].trim()

  // 版本发布提交不进 changelog：它只是打包记录，对使用者没有信息量
  if (type === 'chore' && /^发布/.test(desc))
    return null

  return { section: breaking ? 'breaking' : (TYPE_SECTION[type] ?? 'other'), desc }
}

const version = arg('version')
const to = arg('to', 'HEAD')
const from = arg('from') || previousTag(version, to)
const range = from ? `${from}..${to}` : to

let subjects = []
try {
  subjects = git(['log', range, '--no-merges', '--pretty=format:%s'])
    .split(/\r?\n/)
    .filter(Boolean)
}
catch {
  // 浅克隆或没有历史时退化成默认说明，不让发布失败
}

const groups = new Map(SECTIONS.map(section => [section.key, []]))
for (const subject of subjects) {
  const entry = classify(subject)
  if (!entry)
    continue
  const items = groups.get(entry.section)
  if (!items.includes(entry.desc))
    items.push(entry.desc)
}

const lines = []
for (const section of SECTIONS) {
  const items = groups.get(section.key)
  if (!items.length)
    continue
  lines.push(`### ${section.title}`, '', ...items.map(item => `- ${item}`), '')
}

const notes = lines.length > 0
  ? lines.join('\n').trim()
  : '本次更新包含功能与体验改进。'

const out = arg('out')
if (out) {
  writeFileSync(out, `${notes}\n`)
  console.log(`changelog 已生成：${out}（${subjects.length} 条提交${from ? `，${range}` : ''}）`)
}
else {
  console.log(notes)
}
