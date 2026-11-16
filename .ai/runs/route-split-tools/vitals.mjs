// Cold-load page metrics in Chromium with Lighthouse-like throttling (10 Mbit/s, 40 ms RTT, 4x CPU).
// Usage: node vitals.mjs <baseUrl> <out.json>   — 3 runs per page, cache cleared before each run.
// FCP and LCP come from PerformanceObserver. TBT sums (duration - 50 ms) of long tasks after FCP.
// "settled" is when the last long task or network response ended before 2 s of quiet.
// scriptMs and taskMs come from CDP Performance.getMetrics (ScriptDuration, TaskDuration).
import { chromium } from '/Volumes/CaseSensitive/repos/open-mercato/node_modules/playwright/index.mjs'
import fs from 'node:fs'

const [base, outFile] = process.argv.slice(2)
const pages = ['/backend/customers/people', '/backend/definitions', '/backend/staff/time-tracking', '/terms']
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addInitScript(() => {
  const vitals = { fcp: null, lcp: null, longTasks: [] }
  window.__vitals = vitals
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') vitals.fcp = e.startTime }).observe({ type: 'paint', buffered: true })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) vitals.lcp = e.startTime }).observe({ type: 'largest-contentful-paint', buffered: true })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) vitals.longTasks.push([e.startTime, e.duration]) }).observe({ type: 'longtask', buffered: true })
})
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('Network.enable')
await cdp.send('Performance.enable')

const login = await page.request.post(base + '/api/auth/login', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: 'email=admin%40acme.com&password=secret' })
const claims = JSON.parse(Buffer.from((await login.json()).token.split('.')[1], 'base64url').toString())
await ctx.addCookies([{ name: 'om_selected_tenant', value: claims.tenantId, url: base }, { name: 'om_selected_org', value: claims.orgId, url: base }])

let lastNetwork = 0
let inflight = 0
cdp.on('Network.requestWillBeSent', (e) => { if (e.type !== 'EventSource') inflight++ })
cdp.on('Network.loadingFinished', () => { inflight = Math.max(0, inflight - 1); lastNetwork = Date.now() })
cdp.on('Network.loadingFailed', () => { inflight = Math.max(0, inflight - 1); lastNetwork = Date.now() })

const out = {}
for (const path of pages) {
  const runs = []
  for (let i = 0; i < 3; i++) {
    await cdp.send('Network.clearBrowserCache')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 1250000, uploadThroughput: 625000 })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
    inflight = 0
    const t0 = Date.now()
    await page.goto(base + path, { waitUntil: 'load', timeout: 180000 })
    let lastSeenTasks = -1
    let quietSince = Date.now()
    while (Date.now() - quietSince < 2000) {
      await page.waitForTimeout(200)
      const n = await page.evaluate(() => window.__vitals.longTasks.length)
      if (n !== lastSeenTasks || inflight > 0 || Date.now() - lastNetwork < 200) { lastSeenTasks = n; quietSince = Date.now() }
      if (Date.now() - t0 > 180000) break
    }
    const v = await page.evaluate(() => window.__vitals)
    const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
    const lastTaskEnd = v.longTasks.reduce((a, [s, d]) => Math.max(a, s + d), 0)
    runs.push({
      finalPath: page.url().replace(base, ''),
      fcp: Math.round(v.fcp),
      lcp: Math.round(v.lcp ?? 0),
      tbt: Math.round(v.longTasks.filter(([s]) => s >= (v.fcp ?? 0)).reduce((a, [, d]) => a + Math.max(0, d - 50), 0)),
      lastLongTaskEnd: Math.round(lastTaskEnd),
      settledMs: quietSince - t0,
      scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
      taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
    })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await page.goto('about:blank')
  }
  const keys = ['fcp', 'lcp', 'tbt', 'lastLongTaskEnd', 'settledMs', 'scriptMs', 'taskMs']
  out[path] = { median: Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))])), runs }
  console.log(path, runs.map((r) => r.finalPath).join(','), JSON.stringify(out[path].median))
}
await browser.close()
fs.writeFileSync(outFile, JSON.stringify(out, null, 1))
