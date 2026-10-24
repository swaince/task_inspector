#!/usr/bin/env node
/**
 * 生成 Tauri 自动更新使用的 latest.json。
 *
 * Windows 和 macOS 在两个 job 里分别构建，publish job 下载合并后的产物再调用这里。
 * 签名文件必须存在：缺失就退出非零，让发布失败，而不是发一个装不上的更新。
 *
 *   node tools/make-latest-json.mjs \
 *     --version 1.0.0 --repo owner/repo --tag v1.0.0 --dir release-assets
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback
}

const version = arg('version')
const repo = arg('repo')
const tag = arg('tag')
const dir = arg('dir', 'release-assets')
const notes = arg('notes', '本次更新包含功能与体验改进。')

if (!version || !repo || !tag) {
  console.error('用法: make-latest-json.mjs --version <ver> --repo <owner/repo> --tag <tag> --dir <dir>')
  process.exit(1)
}

/** artifact 下载后可能保留子目录，这里递归找，避免依赖 upload-artifact 的合并布局 */
function walk(current, out = []) {
  for (const entry of readdirSync(current)) {
    const full = join(current, entry)
    if (statSync(full).isDirectory())
      walk(full, out)
    else
      out.push(relative(dir, full))
  }
  return out
}

const files = walk(dir)
const findUpdater = (label, suffix) => {
  const candidates = files.filter(f => f.endsWith(suffix) && !f.endsWith('.sig'))
  if (candidates.length !== 1) {
    console.error(`在 ${dir} 里应当恰好有一个 ${label}，实际找到 ${candidates.length} 个：${candidates.join(', ')}`)
    process.exit(1)
  }
  return candidates[0]
}

/*
 * Tauri v2 默认把 NSIS 安装包本身当作更新包（*-setup.exe + .exe.sig）；
 * 只有 createUpdaterArtifacts: 'v1Compatible' 才产出 .nsis.zip。
 * 两种布局都接受，避免升级 Tauri 后发布脚本静默失配。
 */
const nsisZips = files.filter(f => f.endsWith('.nsis.zip') && !f.endsWith('.sig'))
let windows
if (nsisZips.length === 1) {
  windows = nsisZips[0]
}
else if (nsisZips.length > 1) {
  console.error(`在 ${dir} 里应当恰好有一个 .nsis.zip，实际找到 ${nsisZips.length} 个：${nsisZips.join(', ')}`)
  process.exit(1)
}
else {
  windows = findUpdater('NSIS 安装包（*-setup.exe）', '-setup.exe')
}
const macos = findUpdater('macOS 更新包（*.app.tar.gz）', '.app.tar.gz')

const signatureOf = (file) => {
  const sig = readFileSync(join(dir, `${file}.sig`), 'utf8').trim()
  if (!sig) {
    console.error(`签名文件为空：${file}.sig`)
    process.exit(1)
  }
  return sig
}

const urlOf = file => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(basename(file))}`

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: signatureOf(windows),
      url: urlOf(windows),
    },
    // 通用 macOS 包：两种架构下载同一个 .app.tar.gz，签名也相同
    'darwin-x86_64': {
      signature: signatureOf(macos),
      url: urlOf(macos),
    },
    'darwin-aarch64': {
      signature: signatureOf(macos),
      url: urlOf(macos),
    },
  },
}

writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`latest.json 已生成：${version}（${windows}, ${macos}）`)
