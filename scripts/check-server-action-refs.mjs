#!/usr/bin/env node
/**
 * 产物级门禁：扫描 next build 产物中的 Server Reference 注册表，
 * 确保 "use server" 动作模块注册的每一项、导出的每一项都是 async 函数。
 *
 * 背景：2026-10-28 事故的两种形态——
 * ① 源文件直接 export 常量（静态导出门禁 check-server-exports.mjs 拦截）；
 * ② 本地小模块的值导入被 NAS 构建的打包器内联进动作模块并混进导出表，
 *    源文件表面合法，运行时加载即抛
 *    `A "use server" file can only export async functions` 崩整页。
 * 本脚本在产物层兜底两种形态：按 webpack 模块切分，
 * 凡含 Server Reference 注册调用的模块，其注册项与导出项逐一解析判定。
 *
 * 判定规则：
 * - 解析到 async 定义 → 通过
 * - 解析到数组/对象/字符串/数字字面量 → 立即失败（事故模式）
 * - 无法解析（跨模块引用等） → 警告计数，不阻断（避免误伤未知打包形态）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? '.'
const chunksDir = join(root, '.next/server/chunks')

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    console.warn(`⚠ 目录不存在，跳过：${dir}`)
    return
  }
  for (const name of entries) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (name.endsWith('.js')) yield p
  }
}

// webpack 模块边界：1234:(a,b,c)=>{ —— 无边界时整文件视为一个模块
const MODULE_SPLIT = /\d+:\(\s*[a-zA-Z_$][\w$]*\s*,\s*[a-zA-Z_$][\w$]*\s*,\s*[a-zA-Z_$][\w$]*\s*\)\s*=>\s*\{/g
// 注册调用：(0,<id>.D)([a,b,c]) 或 (0,<id>.D)(a)
const REG_CALL = /\(\s*0\s*,\s*[\w$]+\.D\s*\)\s*\(\s*(\[[^\]]*\]|[\w$]+)/g
// 导出表：<c>.d(<b>,{X:()=>id,...})
const EXPORTS_MAP = /[\w$]+\.d\(\s*[\w$]+\s*,\s*\{([^}]*)\}/g
const EXPORT_ENTRY = /([\w$]+)\s*:\s*\(\s*\)\s*=>\s*([\w$]+)/g
const IDENT = /^[\w$]+$/

function defPatterns(id) {
  const b = `\\b${id}\\b`
  return {
    async: [
      new RegExp(`async function ${b}\\s*\\(`),
      new RegExp(`${b}\\s*=\\s*async\\b`),
      new RegExp(`(?:var|let|const)\\s+${b}\\s*=\\s*async\\b`),
    ],
    literal: [
      new RegExp(`(?:var|let|const)?\\s*${b}\\s*=\\s*\\[`),
      new RegExp(`(?:var|let|const)?\\s*${b}\\s*=\\s*{`),
      new RegExp(`(?:var|let|const)?\\s*${b}\\s*=\\s*["'\`]`),
      new RegExp(`(?:var|let|const)?\\s*${b}\\s*=\\s*\\d`),
    ],
  }
}

/** 判定单个标识符在本模块体内的定义形态 */
function classify(id, body) {
  const { async: ok, literal: bad } = defPatterns(id)
  if (ok.some((re) => re.test(body))) return 'async'
  if (bad.some((re) => re.test(body))) return 'literal'
  return 'unknown'
}

/** 把 chunk 切成 webpack 模块体；无模块边界则整文件为一个模块 */
function splitModules(src) {
  const heads = [...src.matchAll(MODULE_SPLIT)]
  if (heads.length === 0) return [src]
  const bodies = []
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index + heads[i][0].length
    const end = i + 1 < heads.length ? heads[i + 1].index : src.length
    bodies.push(src.slice(start, end))
  }
  return bodies
}

const violations = []
let registrations = 0
let exportsChecked = 0
let unknown = 0

for (const file of walk(chunksDir)) {
  const src = readFileSync(file, 'utf8')
  if (!src.includes('.D)') && !src.includes('.d(')) continue
  for (const body of splitModules(src)) {
    const hasReg = body.search(/\(\s*0\s*,\s*[\w$]+\.D\s*\)\s*\(/) !== -1
    if (!hasReg) continue
    // 1) 注册项必须是 async 函数
    for (const m of body.matchAll(REG_CALL)) {
      const raw = m[1]
      const items = raw.startsWith('[')
        ? raw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
        : [raw.trim()]
      for (const item of items) {
        if (!IDENT.test(item)) {
          unknown++
          continue
        }
        registrations++
        if (classify(item, body) === 'literal') {
          violations.push(`${file}: 注册项 "${item}" 是非函数字面量`)
        } else if (classify(item, body) === 'unknown') {
          unknown++
        }
      }
    }
    // 2) 同一模块的导出表每一项也必须是 async 函数（NAS 构建内联污染形态）
    for (const em of body.matchAll(EXPORTS_MAP)) {
      for (const entry of em[1].matchAll(EXPORT_ENTRY)) {
        const [, , id] = entry
        exportsChecked++
        const kind = classify(id, body)
        if (kind === 'literal') {
          violations.push(`${file}: 导出项 "${id}" 是非函数字面量（疑似值导入内联污染）`)
        } else if (kind === 'unknown') {
          unknown++
        }
      }
    }
  }
}

console.log(
  `✓ Server Reference：注册项 ${registrations} 个，同模块导出项 ${exportsChecked} 个，违规 ${violations.length} 个，未解析 ${unknown} 个`,
)
if (violations.length > 0) {
  console.error('✗ 产物级 use server 校验失败：')
  for (const v of violations) console.error('  - ' + v)
  process.exit(1)
}
console.log('✓ Server Reference 产物校验通过')
