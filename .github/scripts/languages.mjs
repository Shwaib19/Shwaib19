// Builds assets/languages-{dark,light}.svg from the lines I actually authored,
// across every repository the token can read (personal, organization, private).
//
// GitHub's own language cards count the bytes sitting in repositories I own,
// so a committed virtualenv or bin/obj folder outweighs years of real work.
// This script counts my commits instead, and skips generated or vendored code.
//
// Repository names are never printed: the Actions log of a public repository
// is public, and some of the scanned repositories are private.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = process.env.GH_TOKEN
const AUTHOR = process.env.AUTHOR_PATTERN || 'Shwaib19|shwaibkabore19'
const OUT_DIR = process.env.OUT_DIR || 'assets'
// A single hand-written file rarely grows by more than this in one commit;
// beyond it we are looking at a pasted template, a dump or generated code.
const MAX_LINES_PER_FILE = Number(process.env.MAX_LINES_PER_FILE || 1000)
// A whole project uploaded in one commit keeps its language mix but weighs
// no more than this, so a single import cannot dominate the chart.
const MAX_LINES_PER_COMMIT = Number(process.env.MAX_LINES_PER_COMMIT || 3000)
// Commits touching more source files than this are imports or scaffolding.
const MAX_FILES_PER_COMMIT = Number(process.env.MAX_FILES_PER_COMMIT || 250)
const RECENT_DAYS = 365
const LEGEND_SIZE = 6
const CONCURRENCY = 4

if (!TOKEN) {
  console.error('GH_TOKEN is missing: add a METRICS_TOKEN secret (classic PAT with the "repo" scope).')
  process.exit(1)
}

const EXCLUDED = [
  /(^|\/)(node_modules|bower_components|vendors?|dist|build|out|bin|obj|coverage|packages|\.nuxt|\.output|\.next|\.svelte-kit|\.angular|\.dart_tool|\.idea|\.vscode|\.venv|venv|site-packages|__pycache__|staticfiles|[Mm]igrations)\//,
  /(^|\/)[^/]*env[^/]*\/(Scripts|bin|Lib|lib|Include)\//,
  /(^|\/)wwwroot\/lib\//,
  // Assets shipped by Django and its packages, copied in by collectstatic.
  /(^|\/)admin\/(css|js|img|fonts)\//,
  /(^|\/)(rest_framework|debug_toolbar|ckeditor|tinymce|jazzmin|drf-yasg)\//,
  /(^|\/)(static|public|assets)\/(vendors?|libs?|plugins)\//,
  /\.min\.(js|css)$/,
  /\.d\.ts$/,
  /\.(g|designer|generated)\.cs$/i,
]

const LANGUAGES = {
  'C#': { color: '#178600', ext: ['cs'] },
  Razor: { color: '#512be4', ext: ['cshtml', 'razor'] },
  TypeScript: { color: '#3178c6', ext: ['ts', 'tsx', 'mts', 'cts'] },
  JavaScript: { color: '#f1e05a', ext: ['js', 'jsx', 'mjs', 'cjs'] },
  Vue: { color: '#41b883', ext: ['vue'] },
  Svelte: { color: '#ff3e00', ext: ['svelte'] },
  Astro: { color: '#ff5a03', ext: ['astro'] },
  HTML: { color: '#e34c26', ext: ['html', 'htm'] },
  CSS: { color: '#663399', ext: ['css'] },
  SCSS: { color: '#c6538c', ext: ['scss', 'sass'] },
  Python: { color: '#3572a5', ext: ['py'] },
  Dart: { color: '#00b4ab', ext: ['dart'] },
  Java: { color: '#b07219', ext: ['java'] },
  Kotlin: { color: '#a97bff', ext: ['kt', 'kts'] },
  Go: { color: '#00add8', ext: ['go'] },
  Rust: { color: '#dea584', ext: ['rs'] },
  PHP: { color: '#4f5d95', ext: ['php'] },
  C: { color: '#555555', ext: ['c', 'h'] },
  'C++': { color: '#f34b7d', ext: ['cpp', 'cc', 'hpp'] },
  Shell: { color: '#89e051', ext: ['sh', 'bash'] },
  PowerShell: { color: '#5391fe', ext: ['ps1', 'psm1'] },
  Dockerfile: { color: '#2496ed', ext: [] },
}
const OTHER_COLOR = '#8b949e'
const BY_EXT = Object.fromEntries(
  Object.entries(LANGUAGES).flatMap(([name, { ext }]) => ext.map(e => [e, name])),
)

function languageOf(path) {
  if (EXCLUDED.some(re => re.test(path))) return null
  const base = path.slice(path.lastIndexOf('/') + 1)
  if (/^Dockerfile/.test(base) || base.endsWith('.dockerfile')) return 'Dockerfile'
  const dot = base.lastIndexOf('.')
  return dot > 0 ? BY_EXT[base.slice(dot + 1).toLowerCase()] ?? null : null
}

const unquote = path => (path.startsWith('"') ? path.slice(1, -1) : path)

const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${basic}`)
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  GIT_CONFIG_KEY_1: 'core.quotePath',
  GIT_CONFIG_VALUE_1: 'false',
}

function git(args) {
  return new Promise(resolve => {
    const child = spawn('git', args, { env: gitEnv })
    const chunks = []
    child.stdout.on('data', c => chunks.push(c))
    child.stderr.resume()
    child.on('close', code => resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') }))
  })
}

async function listRepositories() {
  const repos = []
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) throw new Error(`GitHub API answered ${res.status} while listing repositories`)
    const batch = await res.json()
    repos.push(...batch)
    if (batch.length < 100) break
  }
  return repos.filter(r => !r.fork && r.size > 0)
}

const seenCommits = new Set()
// File contents already counted, in any repository: a re-upload, a copy of a
// project into a second repository or a squash of an existing branch adds nothing.
const seenBlobs = new Set()
const cutoff = Date.now() - RECENT_DAYS * 86_400_000
const totals = { recent: {}, allTime: {} }
const stats = { repos: 0, failed: 0, commits: 0, bulk: 0, unparsed: 0, firstYear: Infinity }

function record(commit) {
  if (!commit || commit.files.length === 0) return
  if (commit.files.length > MAX_FILES_PER_COMMIT) return void stats.bulk++
  stats.commits++
  stats.firstYear = Math.min(stats.firstYear, new Date(commit.time).getFullYear())
  const size = commit.files.reduce((sum, [, lines]) => sum + lines, 0)
  const scale = Math.min(1, MAX_LINES_PER_COMMIT / size)
  for (const [language, lines] of commit.files) {
    totals.allTime[language] = (totals.allTime[language] || 0) + lines * scale
    if (commit.time >= cutoff) totals.recent[language] = (totals.recent[language] || 0) + lines * scale
  }
}

// Lines added by a file that comes back after I deleted it: only the difference
// with the deleted version counts, not the whole file again.
async function addedSince(dir, before, after, fallback) {
  const diff = await git(['-C', dir, 'diff', '--numstat', '-w', before, after])
  const added = diff.stdout.split('\t')[0]
  return diff.code === 0 && /^\d+$/.test(added) ? Number(added) : fallback
}

async function scan(repo, dir) {
  const clone = await git(['clone', '--bare', '--quiet', repo.clone_url, dir])
  if (clone.code !== 0) return void stats.failed++
  // Oldest first, so deletions are known before a file is added back.
  const log = await git([
    '-C', dir, 'log', '--branches', '--tags', '--no-merges', '--reverse',
    '--regexp-ignore-case', '--extended-regexp', `--author=${AUTHOR}`,
    '-w', '--raw', '--numstat', '--no-abbrev', '--format=%x01%H %at %P%x02%s',
  ])
  if (log.code !== 0) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    return void stats.failed++
  }
  stats.repos++

  const deleted = new Map()
  for (const block of log.stdout.split('\x01').slice(1)) {
    const [header, ...lines] = block.split('\n')
    const [meta, subject] = header.split('\x02')
    const [sha, time, ...parents] = meta.split(' ').filter(Boolean)
    if (seenCommits.has(sha)) continue
    seenCommits.add(sha)
    // A root "Initial commit" is a generator's template (create-next-app, Ionic...), not my code.
    if (parents.length === 0 && /^initial commit/i.test(subject)) continue

    // --raw lists every file first (blobs and status), then --numstat in the same order.
    const raw = lines.filter(l => l.startsWith(':'))
    const numstat = lines.filter(l => /^(\d+|-)\t/.test(l))
    if (raw.length !== numstat.length) {
      stats.unparsed++
      continue
    }
    const commit = { time: Number(time) * 1000, files: [] }
    for (let i = 0; i < raw.length; i++) {
      const [info, ...paths] = raw[i].split('\t')
      const [, , before, after, status] = info.split(' ')
      const path = unquote(paths[paths.length - 1])
      if (status === 'D') {
        deleted.set(path, before)
        continue
      }
      const added = numstat[i].split('\t')[0]
      const language = languageOf(path)
      if (added === '-' || !language || seenBlobs.has(after)) continue
      seenBlobs.add(after)
      let count = Number(added)
      if (status === 'A' && deleted.has(path)) {
        count = await addedSince(dir, deleted.get(path), after, count)
        deleted.delete(path)
      }
      commit.files.push([language, Math.min(count, MAX_LINES_PER_FILE)])
    }
    record(commit)
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}

function shares(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (!total) return []
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const head = sorted.length > LEGEND_SIZE ? sorted.slice(0, LEGEND_SIZE - 1) : sorted
  const rest = sorted.slice(head.length).reduce((sum, [, n]) => sum + n, 0)
  const entries = head.map(([name, n]) => ({ name, color: LANGUAGES[name].color, pct: (100 * n) / total }))
  if (rest) entries.push({ name: 'Other', color: OTHER_COLOR, pct: (100 * rest) / total })
  return entries
}

// Same palette and size as the streak card (github-readme-streak-stats) so both sit side by side.
const THEMES = {
  dark: { bg: '#151515', border: '#e4e2e2', text: '#fefefe', muted: '#9e9e9e', accent: '#fb8c00', track: '#2c2c2c' },
  light: { bg: '#fffefe', border: '#e4e2e2', text: '#151515', muted: '#464646', accent: '#fb8c00', track: '#ececec' },
}
const W = 495
const H = 195
const PAD = 25
const GAP = 30
const COLUMN = (W - 2 * PAD - GAP) / 2
const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif"

function column(entries, label, left, t, id) {
  let x = left
  const segments = entries.map(e => {
    const width = (COLUMN * e.pct) / 100
    const rect = `<rect x="${x.toFixed(2)}" y="62" width="${width.toFixed(2)}" height="8" fill="${e.color}"/>`
    x += width
    return rect
  }).join('')
  const rows = entries.map((e, i) => {
    const y = 92 + i * 17
    return `<circle cx="${left + 4}" cy="${y - 4}" r="4" fill="${e.color}"/>` +
      `<text x="${left + 14}" y="${y}" class="lang">${e.name}</text>` +
      `<text x="${left + COLUMN}" y="${y}" class="pct" text-anchor="end">${e.pct.toFixed(1)}%</text>`
  }).join('')
  return `<text x="${left}" y="52" class="label">${label}</text>` +
    `<clipPath id="${id}"><rect x="${left}" y="62" width="${COLUMN}" height="8" rx="4"/></clipPath>` +
    `<rect x="${left}" y="62" width="${COLUMN}" height="8" rx="4" fill="${t.track}"/>` +
    `<g clip-path="url(#${id})">${segments}</g>${rows}`
}

function card(theme, recent, allTime) {
  const t = THEMES[theme]
  const summary = recent.map(e => `${e.name} ${e.pct.toFixed(1)}%`).join(', ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
<title id="title">Most used languages</title>
<desc id="desc">Share of the lines I authored over the last 12 months: ${summary}.</desc>
<style>
text { font-family: ${FONT}; fill: ${t.text}; }
.title { font-size: 16px; font-weight: 600; }
.note { font-size: 10.5px; fill: ${t.muted}; }
.label { font-size: 10.5px; font-weight: 600; fill: ${t.accent}; letter-spacing: .06em; }
.lang { font-size: 12px; }
.pct { font-size: 12px; fill: ${t.muted}; font-variant-numeric: tabular-nums; }
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="4.5" fill="${t.bg}" stroke="${t.border}"/>
<text x="${PAD}" y="31" class="title">Most Used Languages</text>
<text x="${W - PAD}" y="31" class="note" text-anchor="end">lines I authored · all repos, incl. private</text>
${column(recent, 'LAST 12 MONTHS', PAD, t, `recent-${theme}`)}
${column(allTime, `ALL TIME · SINCE ${stats.firstYear}`, PAD + COLUMN + GAP, t, `all-${theme}`)}
</svg>
`
}

const repos = await listRepositories()
const workdir = mkdtempSync(join(tmpdir(), 'langs-'))
let next = 0
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < repos.length) {
    const i = next++
    await scan(repos[i], join(workdir, String(i)))
  }
}))
rmSync(workdir, { recursive: true, force: true, maxRetries: 3 })

const recent = shares(totals.recent)
const allTime = shares(totals.allTime)
if (!allTime.length) {
  console.error('No authored lines found: check AUTHOR_PATTERN and the token scopes.')
  process.exit(1)
}
mkdirSync(OUT_DIR, { recursive: true })
for (const theme of Object.keys(THEMES)) {
  writeFileSync(join(OUT_DIR, `languages-${theme}.svg`), card(theme, recent, allTime))
}

console.log(`Scanned ${stats.repos} repositories (${stats.failed} unreadable), ${stats.commits} commits authored, ${stats.bulk} bulk and ${stats.unparsed} unparsable commits ignored.`)
console.log(`Last 12 months: ${recent.map(e => `${e.name} ${e.pct.toFixed(1)}%`).join(', ')}`)
console.log(`All time:       ${allTime.map(e => `${e.name} ${e.pct.toFixed(1)}%`).join(', ')}`)
