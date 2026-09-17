// 本机没有可用的 node CLI，只有 node-repl，因此用 API 方式跑 tsc --noEmit。
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cfg = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root)
const program = ts.createProgram(parsed.fileNames, {
  ...parsed.options,
  noEmit: true,
  incremental: false,
})
const diagnostics = ts.getPreEmitDiagnostics(program)

const host = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => root,
  getNewLine: () => '\n',
}

for (const diagnostic of diagnostics.slice(0, 50)) {
  console.log(ts.formatDiagnostic(diagnostic, host).trimEnd())
}
console.log(`TSC_DIAGNOSTICS=${diagnostics.length}`)
