// Cold-cache script bytes per page in Chromium. Usage: node measure.mjs <baseUrl> <out.json>
import { chromium } from '/Volumes/CaseSensitive/repos/open-mercato/node_modules/playwright/index.mjs'
import fs from 'fs'
const base = process.argv[2]
const outFile = process.argv[3]
const pages = ['/backend', '/backend/customers/people', '/backend/definitions', '/backend/staff/time-tracking', '/backend/staff/team-members', '/terms']
const browser = await chromium.launch()
const ctx = await browser.newContext()
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('Network.enable')
let rec = new Map()
cdp.on('Network.responseReceived', e => { if (e.type === 'Script') rec.set(e.requestId, { url: e.response.url, enc: 0, dec: 0 }) })
cdp.on('Network.dataReceived', e => { const r = rec.get(e.requestId); if (r) { r.dec += e.dataLength; r.enc += e.encodedDataLength } })
cdp.on('Network.loadingFinished', e => { const r = rec.get(e.requestId); if (r) r.enc = Math.max(r.enc, e.encodedDataLength) })
const out = {}
async function measure(path) {
  await cdp.send('Network.clearBrowserCache'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  rec = new Map()
  const resp = await page.goto(base + path, { waitUntil: 'load', timeout: 180000 })
  let last = -1, stableSince = Date.now()
  while (Date.now() - stableSince < 3000) { await page.waitForTimeout(250); const n = [...rec.values()].reduce((a, r) => a + r.dec, 0); if (n !== last) { last = n; stableSince = Date.now() } }
  let enc = 0, dec = 0; for (const r of rec.values()) { enc += r.enc; dec += r.dec }
  const finalPath = page.url().replace(base, '')
  out[path] = { status: resp?.status(), finalPath, scripts: rec.size, decoded: dec, transferred: enc, urls: [...rec.values()].map(r => r.url.replace(base, '')) }
  console.log(`${path} -> ${finalPath} [${resp?.status()}]: ${rec.size} scripts, ${(dec/1e6).toFixed(2)} MB decoded, ${(enc/1e6).toFixed(2)} MB transferred`)
}
await measure('/login')
const r = await page.request.post(base + '/api/auth/login', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: 'email=admin%40acme.com&password=secret' })
console.log('login', r.status())
const tok = (await r.json()).token; const claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString())
await ctx.addCookies([{ name: 'om_selected_tenant', value: claims.tenantId, url: base }, { name: 'om_selected_org', value: claims.orgId, url: base }])
for (const p of pages) await measure(p)
await browser.close()
fs.writeFileSync(outFile, JSON.stringify(out, null, 1))
