// "use server" 文件只允许导出 async 函数与类型；运行时导出其他值会在生产环境
// 懒加载该模块时直接抛错（tsc / eslint / next build 均无法提前发现），构建前静态拦截。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const srcDir = join(root, 'src')
const files = []
walk(srcDir)

const violations = []
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  // 文件级指令：第一个语句之前（允许 shebang/注释/空行）。
  const head = source.slice(0, 400)
  const directive = head.match(/^[ \t]*['"]use server['"][ \t]*;?\n/m)
  if (!directive) continue
  const before = head.slice(0, directive.index)
  if (/^['"]use client['"]/m.test(before)) continue

  source.split('\n').forEach((line, index) => {
    const m = line.match(/^export\s+(.*)$/)
    if (!m) return
    const rest = m[1]
    if (/^(async function|type |interface )/.test(rest)) return
    if (/^(const|let|var)\s+[\w$]+\s*[=:]\s*async\b/.test(rest)) return
    violations.push(`${relative(root, file)}:${index + 1} export ${rest.slice(0, 60)}`)
  })
}

if (violations.length > 0) {
  console.error('✖ "use server" 文件存在非法运行时导出：')
  for (const v of violations) console.error(`  ${v}`)
  console.error('常量/对象请移到普通模块，只允许导出 async 函数与类型。\n')
  process.exit(1)
}
console.log('✓ use server 导出检查通过')

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full)
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full)
  }
}
