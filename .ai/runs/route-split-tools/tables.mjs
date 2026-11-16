// Prints Markdown tables comparing baseline and after measurements from .ai/runs/route-split-logs.
import fs from 'node:fs'
const dir = '/Volumes/CaseSensitive/repos/open-mercato/.ai/runs/route-split-logs'
const read = (name) => JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf8'))
const mb = (bytes) => (bytes / 1e6).toFixed(2)
const pct = (before, after) => `${(((after - before) / before) * 100).toFixed(0)}%`

const before = read('baseline-entry.json')
const after = read('after-entry.json')
const catchAll = '/(backend)/backend/[...slug]'
const shardRoute = (key) => `/(backend)/backend/(generated)/${key}/[[...slug]]`
const rows = [
  ['customers (people)', catchAll, shardRoute('customers')],
  ['definitions (workflows)', catchAll, shardRoute('definitions')],
  ['staff (time tracking, team)', catchAll, shardRoute('staff')],
  ['sales', catchAll, shardRoute('sales')],
  ['api-keys (smallest)', catchAll, shardRoute('api-keys')],
  ['design-system (largest)', catchAll, shardRoute('design-system')],
  ['backend fallback catch-all', catchAll, catchAll],
  ['frontend catch-all', '/(frontend)/[...slug]', '/(frontend)/[...slug]'],
  ['/backend dashboard', '/(backend)/backend', '/(backend)/backend'],
  ['/login', '/login', '/login'],
  ['/start', '/start', '/start'],
]
console.log('| Page / route | Before files | Before raw MB | Before gzip MB | After route | After files | After raw MB | After gzip MB | Δ gzip |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const [label, b, a] of rows) {
  const x = before[b], y = after[a]
  console.log(`| ${label} | ${x.files} | ${mb(x.raw)} | ${mb(x.gz)} | \`${a}\` | ${y.files} | ${mb(y.raw)} | ${mb(y.gz)} | ${pct(x.gz, y.gz)} |`)
}

const browserBefore = read('baseline-measure.json')
const browserAfterFile = `${dir}/after-measure.json`
if (fs.existsSync(browserAfterFile)) {
  const browserAfter = read('after-measure.json')
  console.log('\n| Page (cold cache) | Before scripts | Before decoded MB | Before transferred MB | After scripts | After decoded MB | After transferred MB | Δ transferred |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const path of Object.keys(browserBefore)) {
    const x = browserBefore[path], y = browserAfter[path]
    console.log(`| \`${path}\` | ${x.scripts} | ${mb(x.decoded)} | ${mb(x.transferred)} | ${y.scripts} | ${mb(y.decoded)} | ${mb(y.transferred)} | ${pct(x.transferred, y.transferred)} |`)
  }
}
