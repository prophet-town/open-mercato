// Server-side cost of serving one page per backend module shard, twice each.
// Usage: node server.mjs <baseUrl> <out.json>
// Records RSS of the process tree listening on the port, and full response time per request.
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const [base, outFile] = process.argv.slice(2)
const paths = JSON.parse(fs.readFileSync(new URL('./module-paths.json', import.meta.url), 'utf8'))
const port = new URL(base).port
const listenerPid = Number(execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).toString().trim().split('\n')[0])

function rssMb() {
  const rows = execSync('ps -A -o pid=,ppid=,rss=').toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
  const tree = new Set([listenerPid])
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true } }
  return Math.round(rows.filter(([pid]) => tree.has(pid)).reduce((a, [, , rss]) => a + rss, 0) / 1024)
}

const login = await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'email=admin%40acme.com&password=secret',
})
const body = await login.json()
const claims = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString())
const cookie = [...login.headers.getSetCookie().map((c) => c.split(';')[0]), `om_selected_tenant=${claims.tenantId}`, `om_selected_org=${claims.orgId}`].join('; ')

const out = { rssAtStartMb: rssMb(), passes: [] }
for (const pass of [1, 2]) {
  const hits = []
  for (const path of paths) {
    const t0 = performance.now()
    const res = await fetch(base + path, { headers: { cookie }, redirect: 'manual' })
    await res.text()
    hits.push({ path, status: res.status, ms: Math.round(performance.now() - t0) })
  }
  const ms = hits.map((h) => h.ms).sort((a, b) => a - b)
  const summary = {
    pass,
    rssAfterMb: rssMb(),
    totalMs: ms.reduce((a, b) => a + b, 0),
    medianMs: ms[Math.floor(ms.length / 2)],
    p90Ms: ms[Math.floor(ms.length * 0.9)],
    maxMs: ms[ms.length - 1],
    statuses: hits.reduce((a, h) => ({ ...a, [h.status]: (a[h.status] ?? 0) + 1 }), {}),
  }
  out.passes.push({ ...summary, hits })
  console.log(JSON.stringify(summary))
}
await new Promise((resolve) => setTimeout(resolve, 10000))
out.rssAfterIdleMb = rssMb()
console.log('rss start', out.rssAtStartMb, 'after 10 s idle', out.rssAfterIdleMb)
fs.writeFileSync(outFile, JSON.stringify(out, null, 1))
