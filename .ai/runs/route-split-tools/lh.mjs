// Lighthouse (desktop preset, headless Chrome) on a few pages, 3 runs each, logged in via a Cookie header.
// Usage: node lh.mjs <baseUrl> <label>   (writes <label>-lh.json into route-split-logs)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const [base, label] = process.argv.slice(2)
const logs = '/Volumes/CaseSensitive/repos/open-mercato/.ai/runs/route-split-logs'
const work = '/private/tmp/claude-501/-Volumes-CaseSensitive-repos-open-mercato/02621004-b3ca-4232-8317-d3d018dd0afd/scratchpad'
const pages = ['/backend/customers/people', '/backend/definitions', '/backend/staff/time-tracking', '/terms']

const login = await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'email=admin%40acme.com&password=secret',
})
const body = await login.json()
const claims = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString())
const cookie = [...login.headers.getSetCookie().map((c) => c.split(';')[0]), `om_selected_tenant=${claims.tenantId}`, `om_selected_org=${claims.orgId}`].join('; ')

const metric = (lhr, id) => lhr.audits[id]?.numericValue ?? null
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const out = {}
for (const path of pages) {
  const runs = []
  for (let i = 0; i < 3; i++) {
    const file = `${work}/lh-${label}-${path.replace(/\W+/g, '_')}-${i}.json`
    execFileSync('npx', ['-y', 'lighthouse@12.8.2', base + path, '--preset=desktop', '--only-categories=performance',
      '--output=json', `--output-path=${file}`, '--quiet', `--extra-headers=${JSON.stringify({ Cookie: cookie })}`,
      '--chrome-flags=--headless=new --no-first-run'], { cwd: work, env: { ...process.env, CHROME_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, stdio: 'ignore' })
    const lhr = JSON.parse(fs.readFileSync(file, 'utf8'))
    runs.push({
      finalUrl: lhr.finalDisplayedUrl,
      score: lhr.categories.performance.score,
      fcp: metric(lhr, 'first-contentful-paint'),
      lcp: metric(lhr, 'largest-contentful-paint'),
      tti: metric(lhr, 'interactive'),
      tbt: metric(lhr, 'total-blocking-time'),
      jsBootup: metric(lhr, 'bootup-time'),
      mainThread: metric(lhr, 'mainthread-work-breakdown'),
      bytes: metric(lhr, 'total-byte-weight'),
    })
  }
  const keys = ['score', 'fcp', 'lcp', 'tti', 'tbt', 'jsBootup', 'mainThread', 'bytes']
  out[path] = { median: Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))])), runs }
  console.log(path, runs[0].finalUrl, JSON.stringify(out[path].median))
}
fs.writeFileSync(`${logs}/${label}-lh.json`, JSON.stringify(out, null, 1))
