// Dev-mode first-hit measurement against an already started `next dev` (cold .mercato/next/dev).
// Usage: node dev-measure.mjs <baseUrl> <out.json> <path...>
// Samples RSS of every process whose args mention next (next-server / turbopack) every 500 ms,
// logs in, hits each path once with auth cookies, then reads compile events from the Next trace.
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const [base, outFile, ...paths] = process.argv.slice(2)
const traceFile = '/Volumes/CaseSensitive/repos/open-mercato/apps/mercato/.mercato/next/dev/trace'

const port = new URL(base).port
const listenerPid = Number(execSync(`pgrep -f route-split-tools/dev-cold.sh`).toString().trim().split('\n')[0])
function nextRssMb() {
  const rows = execSync('ps -A -o pid=,ppid=,rss=').toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
  const tree = new Set([listenerPid])
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true } }
  return Math.round(rows.filter(([pid]) => tree.has(pid)).reduce((a, [, , rss]) => a + rss, 0) / 1024)
}

let peak = 0
const sampler = setInterval(() => { peak = Math.max(peak, nextRssMb()) }, 500)
const out = { rssAtStartMb: nextRssMb(), hits: [], timeline: [] }
const t0 = Date.now()
const timeline = setInterval(() => out.timeline.push([Date.now() - t0, nextRssMb()]), 1000)

const loginStart = Date.now()
const login = await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'email=admin%40acme.com&password=secret',
  redirect: 'manual',
})
const loginBody = await login.json()
const claims = JSON.parse(Buffer.from(loginBody.token.split('.')[1], 'base64url').toString())
const setCookies = login.headers.getSetCookie().map((c) => c.split(';')[0])
const cookie = [...setCookies, `om_selected_tenant=${claims.tenantId}`, `om_selected_org=${claims.orgId}`].join('; ')
out.login = { status: login.status, ms: Date.now() - loginStart, rssAfterMb: nextRssMb() }
console.log('login', out.login)

for (const path of paths) {
  peak = nextRssMb()
  const start = Date.now()
  const res = await fetch(base + path, { headers: { cookie }, redirect: 'manual' })
  const html = await res.text()
  const hit = { path, status: res.status, ms: Date.now() - start, bytes: html.length, rssAfterMb: nextRssMb(), rssPeakMb: peak }
  out.hits.push(hit)
  console.log(hit)
}
clearInterval(sampler)
clearInterval(timeline)
out.rssPeakDuringRunMb = Math.max(...out.timeline.map(([, rss]) => rss))

const events = JSON.parse('[' + fs.readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => l.trim().replace(/^\[|\]$/g, '')).filter(Boolean).join(',') + ']').flat()
out.compile = events
  .filter((e) => e.name === 'compile-path' || e.name === 'ensure-page' || e.name === 'handle-request')
  .map((e) => ({ name: e.name, ms: Math.round(e.duration / 1000), tags: e.tags }))
for (const e of out.compile) console.log(e.name.padEnd(15), String(e.ms).padStart(7), 'ms', JSON.stringify(e.tags))
out.rssEndMb = nextRssMb()
fs.writeFileSync(outFile, JSON.stringify(out, null, 1))
