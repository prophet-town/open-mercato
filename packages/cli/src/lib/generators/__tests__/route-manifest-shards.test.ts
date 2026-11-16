import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findAppOwnedBackendSegments,
  getRouteManifestShardKey,
  renderBackendRoutePageOutputs,
  renderRouteManifestShardOutputs,
  renderRouteMetadataOutput,
  renderRouteRegistryFacadesOutput,
} from '../route-manifest-shards'

describe('route manifest shards', () => {
  it('groups static request prefixes and preserves dynamic-prefix fallbacks', () => {
    expect(getRouteManifestShardKey('api', '/customers/[id]')).toBe('customers')
    expect(getRouteManifestShardKey('backend', '/backend/sales/orders')).toBe('sales')
    expect(getRouteManifestShardKey('backend', '/backend/[tenant]/settings')).toBe('__dynamic')
    expect(getRouteManifestShardKey('api', '/')).toBe('__root')
  })

  it('renders a small loader graph with exact and dynamic shards', () => {
    const outputs = renderRouteManifestShardOutputs('api', [
      { path: '/customers', declaration: `{ moduleId: 'customers' } as any` },
      { path: '/sales/orders', declaration: `{ moduleId: 'sales' } as any` },
      { path: '/[module]/health', declaration: `{ moduleId: 'dynamic' } as any` },
    ])
    const loader = outputs.find((entry) => entry.fileName === 'api-route-shards.generated.ts')?.content ?? ''

    expect(outputs.filter((entry) => entry.fileName.includes('route-shard.'))).toHaveLength(3)
    expect(loader).toContain(`case "customers":`)
    expect(loader).toContain(`case "sales":`)
    expect(loader).toContain(`const dynamicShard = await loadShard("__dynamic")`)
    expect(loader).toContain(`export const apiRouteFacades`)
    expect(loader).toContain(`loadApiRouteManifestByOrdinal(ordinal)`)
    expect(loader).not.toContain("moduleId: 'customers'")
  })

  it('retains global route order when exact and dynamic entries interleave', () => {
    const outputs = renderRouteManifestShardOutputs('api', [
      { path: '/customers/new', declaration: `{ path: '/customers/new' } as any` },
      { path: '/[module]/health', declaration: `{ path: '/[module]/health' } as any` },
      { path: '/customers/[id]', declaration: `{ path: '/customers/[id]' } as any` },
      { path: '/', declaration: `{ path: '/' } as any` },
    ])
    const customerShard = outputs.find((entry) => entry.content.includes(`/customers/new`))?.content ?? ''
    const dynamicShard = outputs.find((entry) => entry.content.includes(`/[module]/health`))?.content ?? ''
    const loader = outputs.find((entry) => entry.fileName === 'api-route-shards.generated.ts')?.content ?? ''

    expect(customerShard).toContain('export const routeOrders = [0, 2]')
    expect(dynamicShard).toContain('export const routeOrders = [1]')
    expect(loader).toContain(`case "__root":`)
    expect(loader).toContain(`.sort((a, b) => a.order - b.order)`)
    expect(loader).toContain(`const ROUTE_SHARD_KEYS = ["customers","__dynamic","customers","__root"]`)
  })

  it('indents every line of a multi-line declaration inside the shard array', () => {
    const declaration = ['{', '  moduleId: "customers",', '  path: "/customers"', '} as any'].join('\n')
    const outputs = renderRouteManifestShardOutputs('api', [{ path: '/customers', declaration }])
    const shard = outputs.find((entry) => entry.fileName.includes('route-shard.'))?.content ?? ''

    expect(shard).toContain([
      'export const routes: ApiRouteManifestEntry[] = [',
      '  {',
      '    moduleId: "customers",',
      '    path: "/customers"',
      '  } as any',
      ']',
    ].join('\n'))
  })

  it('renders metadata without load functions while retaining metadata imports', () => {
    const output = renderRouteMetadataOutput('backend', [{
      path: '/backend/settings',
      declaration: `{ moduleId: 'settings', ...resolvePageRouteMetadata('/backend/settings', META.metadata) }`,
      imports: [`import * as META from '@app/settings/meta'`],
    }])

    expect(output.fileName).toBe('backend-route-metadata.generated.ts')
    expect(output.content).toContain(`import * as META from '@app/settings/meta'`)
    expect(output.content).toContain(`Omit<BackendRouteManifestEntry, 'load'>`)
    expect(output.content).not.toContain('load: async')
  })

  it('renders one page route per static backend shard that registers only its own shard', () => {
    const entries = [
      { path: '/backend/customers/people', declaration: `{ moduleId: 'customers' } as any` },
      { path: '/backend/sales/orders', declaration: `{ moduleId: 'sales' } as any` },
      { path: '/backend/customers/companies', declaration: `{ moduleId: 'customers' } as any` },
    ]
    const pages = renderBackendRoutePageOutputs(entries)
    expect(pages.map((page) => page.key)).toEqual(['customers', 'sales'])
    const customers = pages[0].content
    expect(customers).toContain(`import * as shard from '@/.mercato/generated/backend-route-shard.000.customers.generated'`)
    expect(customers).toContain(`registerRouteManifestShard('backend', "customers", shard)`)
    expect(customers).not.toContain('sales')
    expect(customers).toContain(`export const dynamic = 'force-dynamic'`)
    expect(customers).toContain(`const prefix = ["customers"]`)
    expect(customers).toContain(`renderBackendRoute(props, getBackendRouteManifests(), prefix)`)

    const facades = renderRouteRegistryFacadesOutput('backend', entries).content
    expect(facades).toContain(`createRouteManifestShardFacades("backend", backendRouteMetadata, ["customers","sales","customers"])`)
    expect(facades).not.toContain('import(')
  })

  it('makes every backend page route register the dynamic-prefix shard too', () => {
    const pages = renderBackendRoutePageOutputs([
      { path: '/backend/customers', declaration: `{} as any` },
      { path: '/backend/[tenant]/settings', declaration: `{} as any` },
    ])
    expect(pages.map((page) => page.key)).toEqual(['customers'])
    expect(pages[0].content).toContain(`registerRouteManifestShard('backend', "__dynamic", dynamicShard)`)
  })

  it('finds app-owned backend segments through route groups and parallel-route slots', () => {
    const appRouterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-app-router-'))
    const touch = (relativePath: string) => {
      const file = path.join(appRouterDir, relativePath)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'export default function Page() { return null }\n')
    }
    try {
      touch('(backend)/backend/(custom)/customers/page.tsx')
      touch('(admin)/backend/@modal/sales/page.tsx')
      touch('(backend)/backend/(generated)/staff/[[...slug]]/page.tsx')
      touch('api/backend/catalog/route.ts')
      const generatedDir = path.join(appRouterDir, '(backend)', 'backend', '(generated)')

      const owned = findAppOwnedBackendSegments(appRouterDir, generatedDir)
      expect(owned.has('customers')).toBe(true)
      expect(owned.has('sales')).toBe(true)
      expect(owned.has('staff')).toBe(false)
      expect(owned.has('catalog')).toBe(false)
    } finally {
      fs.rmSync(appRouterDir, { recursive: true, force: true })
    }
  })
})

