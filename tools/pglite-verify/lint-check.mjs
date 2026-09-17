// 项目用的是 .eslintrc.json，ESLint 9 需要显式走 legacy 引擎。
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LegacyESLint } from 'eslint/use-at-your-own-risk'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const eslint = new LegacyESLint({ cwd: root })
const results = await eslint.lintFiles(['src/**/*.{ts,tsx}'])
const formatter = await eslint.loadFormatter('stylish')
const output = await formatter.format(results)

if (output.trim()) console.log(output)
const errors = results.reduce((sum, item) => sum + item.errorCount, 0)
const warnings = results.reduce((sum, item) => sum + item.warningCount, 0)
console.log(`ESLINT errors=${errors} warnings=${warnings} files=${results.length}`)
