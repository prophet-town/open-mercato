// Client-side navigation between backend modules, clicking the sidebar links.
// Usage: node nav.mjs <baseUrl> <out.json>
// For each step: time until the target page's wrapper (data-component-handle="page:<path>") is visible,
// time until the network is quiet for 1 s (SSE excluded), and script / RSC bytes fetched by the click.
import { chromium } from '/Volumes/CaseSensitive/repos/open-mercato/node_modules/playwright/index.mjs'
import fs from 'node:fs'

const [base, outFile] = process.argv.slice(2)
const start = '/backend/customers/people'
const steps = [
  '/backend/customers/companies',
  '/backend/sales/orders',
  '/backend/catalog/products',
  '/backend/definitions',
  '/backend/staff/time-tracking',
  '/backend/customers/people',
  '/backend/sales/quotes',
]

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('Network.enable')
if (process.env.THROTTLE) {
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 1250000, uploadThroughput: 625000 })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
}
let rec = new Map()
let lastActivity = Date.now()
cdp.on('Network.requestWillBeSent', (e) => {
  if (e.type === 'EventSource' || /\/api\/(events|.*stream)/.test(e.request.url)) return
  rec.set(e.requestId, { url: e.request.url, type: e.type, enc: 0, dec: 0, done: false })
  lastActivity = Date.now()
})
cdp.on('Network.dataReceived', (e) => { const r = rec.get(e.requestId); if (r) { r.dec += e.dataLength; r.enc += e.encodedDataLength; lastActivity = Date.now() } })
cdp.on('Network.loadingFinished', (e) => { const r = rec.get(e.requestId); if (r) { r.enc = Math.max(r.enc, e.encodedDataLength); r.done = true; lastActivity = Date.now() } })
cdp.on('Network.loadingFailed', (e) => { const r = rec.get(e.requestId); if (r) r.done = true })

async function quiet(t0) {
  while (true) {
    await page.waitForTimeout(100)
    const pending = [...rec.values()].some((r) => !r.done && r.type !== 'EventSource')
    if (!pending && Date.now() - lastActivity >= 1000) return lastActivity - t0
    if (Date.now() - t0 > 180000) return -1
  }
}

function summarize() {
  const all = [...rec.values()]
  const scripts = all.filter((r) => r.type === 'Script')
  const rsc = all.filter((r) => r.type === 'Fetch' && /_rsc=|\?_rsc|text\/x-component/.test(r.url))
  const sum = (list, key) => list.reduce((a, r) => a + r[key], 0)
  return {
    scripts: scripts.length,
    scriptTransferred: sum(scripts, 'enc'),
    scriptDecoded: sum(scripts, 'dec'),
    fetches: all.filter((r) => r.type === 'Fetch').length,
    rscTransferred: sum(rsc, 'enc'),
    allTransferred: sum(all, 'enc'),
  }
}

const login = await page.request.post(base + '/api/auth/login', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: 'email=admin%40acme.com&password=secret' })
const claims = JSON.parse(Buffer.from((await login.json()).token.split('.')[1], 'base64url').toString())
await ctx.addCookies([{ name: 'om_selected_tenant', value: claims.tenantId, url: base }, { name: 'om_selected_org', value: claims.orgId, url: base }])

const out = { steps: [] }
await cdp.send('Network.clearBrowserCache')
rec = new Map()
let t0 = Date.now()
await page.goto(base + start, { waitUntil: 'commit' })
await page.locator(`[data-component-handle="page:${start}"]`).waitFor({ timeout: 180000 })
const coldVisible = Date.now() - t0
out.cold = { path: start, visibleMs: coldVisible, quietMs: await quiet(t0), ...summarize() }
console.log('cold', JSON.stringify(out.cold))

for (const target of steps) {
  const link = page.locator(`a[href="${target}"]`).first()
  if (await link.count() === 0) {
    const hrefs = await page.$$eval('a[href^="/backend/"]', (as) => as.map((a) => a.getAttribute('href')))
    console.log('missing link', target, 'available sample', hrefs.slice(0, 40).join(' '))
    out.steps.push({ path: target, missing: true })
    continue
  }
  await link.scrollIntoViewIfNeeded().catch(() => {})
  rec = new Map()
  t0 = Date.now()
  await link.click()
  await page.waitForURL(base + target, { timeout: 60000 })
  const urlMs = Date.now() - t0
  await page.locator(`[data-component-handle="page:${target}"]`).waitFor({ timeout: 180000 })
  const visibleMs = Date.now() - t0
  const step = { path: target, urlMs, visibleMs, quietMs: await quiet(t0), fullReload: false, ...summarize() }
  step.fullReload = [...rec.values()].some((r) => r.type === 'Document')
  out.steps.push(step)
  console.log(JSON.stringify(step))
}
await browser.close()
fs.writeFileSync(outFile, JSON.stringify(out, null, 1))
