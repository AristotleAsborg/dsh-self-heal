/**
 * write-host-down-readme.mjs — the FIXED script that puts the general guide at a
 * fixed location when every automatic rung has failed.
 *
 * Fixed location (stable, right next to the launcher so a human staring at the
 * launcher window finds it):  D:\dsh\HOST-DOWN-README.md
 * History copy (never overwritten):  <incident>\HOST-DOWN-README.md
 *
 * The guide text itself lives in one versioned source file; this script only copies
 * it and appends the incident facts (classification, ladder outcomes, error lines),
 * so the two never drift apart.
 *
 * Usage: node write-host-down-readme.mjs [--incident <dir>] [--print]
 * Exit:  0 = written, 2 = the guide source is missing (nothing else can be done here).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'

const GUIDE = 'D:\\dsh\\config\\repair\\HOST-DOWN-README.md'
const FIXED = 'D:\\dsh\\HOST-DOWN-README.md'
const INCIDENTS = 'D:\\dsh\\state\\incidents'

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const newest = () => {
  const dirs = readdirSync(INCIDENTS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, at: statSync(`${INCIDENTS}\\${e.name}`).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  return dirs.length === 0 ? undefined : `${INCIDENTS}\\${dirs[0].name}`
}
const incident = opt('--incident', newest())

if (!existsSync(GUIDE)) {
  console.error(`write-host-down-readme: 缺少通用说明源文件：${GUIDE}`)
  process.exit(2)
}

const readMaybe = (path, maxLines = 80) => {
  if (path === undefined || !existsSync(path)) return '(无)'
  const lines = readFileSync(path, 'utf8').split('\n')
  return lines.slice(0, maxLines).join('\n') + (lines.length > maxLines ? `\n…（共 ${lines.length} 行，已截断）` : '')
}

const incidentBlock = [
  '',
  '---',
  '',
  `## 本次事故（自动追加 ${new Date().toISOString()}）`,
  '',
  `- 事故目录：${incident ?? '(无)'}`,
  `- 已自动尝试：启动前闸门 → 看护脚本（允许清单内修复）→ L1 修复会话（headless）→ L1.5 出厂 profile（rescue）`,
  '- **上面四级都没能救回来**，所以留下了这份文档。',
  '',
  '### 分级结果（ladder.md）',
  '',
  '```',
  readMaybe(incident === undefined ? undefined : `${incident}\\ladder.md`, 40),
  '```',
  '',
  '### 事故摘要（summary.md）',
  '',
  '```',
  readMaybe(incident === undefined ? undefined : `${incident}\\summary.md`, 50),
  '```',
  '',
  '### 报错原文尾部（console-tail.txt 的最后 25 行）',
  '',
  '```',
  (() => {
    if (incident === undefined || !existsSync(`${incident}\\console-tail.txt`)) return '(无)'
    return readFileSync(`${incident}\\console-tail.txt`, 'utf8').split('\n').slice(-25).join('\n')
  })(),
  '```',
  ''
].join('\n')

const guide = readFileSync(GUIDE, 'utf8')
writeFileSync(FIXED, `${guide.replace(/\s+$/u, '')}\n${incidentBlock}`, 'utf8')
if (incident !== undefined) {
  mkdirSync(incident, { recursive: true })
  copyFileSync(FIXED, `${incident}\\HOST-DOWN-README.md`)
}

console.log(`[host-down] 通用说明已写到固定位置：${FIXED}`)
if (incident !== undefined) console.log(`[host-down] 历史副本：${incident}\\HOST-DOWN-README.md`)
if (argv.includes('--print')) console.log(`[host-down] 字数：${readFileSync(FIXED, 'utf8').length}`)
process.exit(0)
