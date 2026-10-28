// "use server" 文件两道静态门禁，运行时崩溃类构建前拦截：
// 规则 1：只允许导出 async 函数与类型；运行时导出其他值会在生产环境
//         懒加载该模块时直接抛错（tsc / eslint / next build 均无法提前发现）。
// 规则 2：禁止值导入「只有一个运行时消费者」的本地模块。2026-10-28 事故形态：
//         这种小模块会被 webpack 拼接进 use server 模块，其导出（常量/对象）
//         混入并集导出表，Next 枚举校验时崩整页；是否拼接取决于 chunk 划分，
//         源文件层看不出，产物级门禁（check-server-action-refs.mjs）再兜底。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = process.cwd()
const srcDir = join(root, 'src')
const files = []
walk(srcDir)

// 存量豁免：单消费者但已在生产长期验证无碍的模块（新增请勿加入）。
const GRANDFATHERED = new Set([
  'lib/calc',
  'lib/country-flags',
  'lib/daily-order-costs-server',
  'schemas/business-order-commission',
  'schemas/company',
  'schemas/daily-order-workflow',
  'schemas/permission',
  'schemas/pi',
  'schemas/weight',
])

// ---- 全树收集本地导入，建立「解析后路径 → 运行时导入者集合」 ----
const importRecords = [] // { file, spec, hasValue }
const runtimeImporters = new Map() // resolvedPath -> Set(importerFile)

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  for (const m of source.matchAll(
    /import\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/g,
  )) {
    const [, isType, clause, spec] = m
    if (!spec.startsWith('.') && !spec.startsWith('@/')) continue
    let hasValue = false
    if (!isType) {
      const cleaned = clause
        .replace(/\btype\s+[\w$]+(\s+as\s+[\w$]+)?\s*,?\s*/g, '')
        .trim()
      hasValue = cleaned.replace(/[{}]/g, '').trim().length > 0
    }
    importRecords.push({ file, spec, hasValue })
    if (!hasValue) continue
    const resolved = resolveSpec(file, spec)
    if (!resolved) continue
    if (!runtimeImporters.has(resolved)) runtimeImporters.set(resolved, new Set())
    runtimeImporters.get(resolved).add(file)
  }
}

const exportViolations = []
const importViolations = []

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  // 文件级指令：第一个语句之前（允许 shebang/注释/空行）。
  const head = source.slice(0, 400)
  const directive = head.match(/^[ \t]*['"]use server['"][ \t]*;?\n/m)
  if (!directive) continue
  const before = head.slice(0, directive.index)
  if (/^['"]use client['"]/m.test(before)) continue

  // 规则 1：导出形状
  source.split('\n').forEach((line, index) => {
    const m = line.match(/^export\s+(.*)$/)
    if (!m) return
    const rest = m[1]
    if (/^(async function|type |interface )/.test(rest)) return
    if (/^(const|let|var)\s+[\w$]+\s*[=:]\s*async\b/.test(rest)) return
    exportViolations.push(`${relative(root, file)}:${index + 1} export ${rest.slice(0, 60)}`)
  })

  // 规则 2：值导入形状
  for (const rec of importRecords) {
    if (rec.file !== file || !rec.hasValue) continue
    const resolved = resolveSpec(file, rec.spec)
    if (!resolved) continue
    const importers = runtimeImporters.get(resolved)
    if (!importers || importers.size > 1) continue
    const rel = relative(srcDir, resolved).replace(/\.(ts|tsx)$/, '')
    if (GRANDFATHERED.has(rel)) continue
    importViolations.push(
      `${relative(root, file)} 值导入 "${rec.spec}"——该模块只有一个运行时消费者，` +
        `可能被拼接进 use server 模块污染导出表；请把所需值直接定义在本文件（私有常量），` +
        `或改为 import type（类型编译期擦除，安全）。`,
    )
  }
}

if (exportViolations.length > 0) {
  console.error('✖ "use server" 文件存在非法运行时导出：')
  for (const v of exportViolations) console.error(`  ${v}`)
  console.error('常量/对象请移到普通模块，只允许导出 async 函数与类型。\n')
}
if (importViolations.length > 0) {
  console.error('✖ "use server" 文件存在高危本地值导入（单消费者模块）：')
  for (const v of importViolations) console.error(`  ${v}`)
  console.error('')
}
if (exportViolations.length + importViolations.length > 0) process.exit(1)
console.log('✓ use server 导出/导入检查通过')

/** 把 './x' / '@/lib/x' 解析到真实文件路径（尝试 tsx / index） */
function resolveSpec(importer, spec) {
  const base = spec.startsWith('@/')
    ? join(srcDir, spec.slice(2))
    : resolve(dirname(importer), spec)
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full)
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full)
  }
}
