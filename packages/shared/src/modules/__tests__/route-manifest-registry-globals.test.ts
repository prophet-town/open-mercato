import type {
  ApiRouteManifestEntry,
  BackendRouteManifestEntry,
  FrontendRouteManifestEntry,
} from '../registry'

type RegistryModule = typeof import('../registry')

function loadIsolatedRegistry(): RegistryModule {
  let loaded: RegistryModule | null = null
  jest.isolateModules(() => {
    loaded = require('../registry') as RegistryModule
  })
  if (!loaded) throw new Error('[internal] registry module failed to load')
  return loaded
}

const apiRoute: ApiRouteManifestEntry = {
  moduleId: 'customers',
  kind: 'route-file',
  path: '/customers/companies',
  methods: ['GET', 'PUT'],
  load: async () => ({}),
}

const backendRoute: BackendRouteManifestEntry = {
  moduleId: 'customers',
  pattern: '/backend/customers',
  load: async () => () => null,
}

const frontendRoute: FrontendRouteManifestEntry = {
  moduleId: 'portal',
  pattern: '/portal',
  load: async () => () => null,
}

describe('route manifest registries across duplicated module instances', () => {
  afterEach(() => {
    const registry = loadIsolatedRegistry()
    registry.registerApiRouteManifests([])
    registry.registerBackendRouteManifests([])
    registry.registerFrontendRouteManifests([])
  })

  it('exposes API route manifests registered by another bundle copy', () => {
    const apiBundleCopy = loadIsolatedRegistry()
    const pageBundleCopy = loadIsolatedRegistry()
    expect(apiBundleCopy).not.toBe(pageBundleCopy)

    apiBundleCopy.registerApiRouteManifests([apiRoute])

    expect(pageBundleCopy.getApiRouteManifests().map((route) => route.path)).toEqual(['/customers/companies'])
  })

  it('exposes backend and frontend route manifests registered by another bundle copy', () => {
    const writer = loadIsolatedRegistry()
    const reader = loadIsolatedRegistry()

    writer.registerBackendRouteManifests([backendRoute])
    writer.registerFrontendRouteManifests([frontendRoute])

    expect(reader.getBackendRouteManifests().map((route) => route.pattern)).toEqual(['/backend/customers'])
    expect(reader.getFrontendRouteManifests().map((route) => route.pattern)).toEqual(['/portal'])
  })

  it('keeps each registry kind independent', () => {
    const writer = loadIsolatedRegistry()
    const reader = loadIsolatedRegistry()

    writer.registerApiRouteManifests([apiRoute])

    expect(reader.getBackendRouteManifests()).toEqual([])
    expect(reader.getFrontendRouteManifests()).toEqual([])
  })

  it('loads facade routes through a shard registered by another bundle copy', async () => {
    const bootstrapCopy = loadIsolatedRegistry()
    const pageBundleCopy = loadIsolatedRegistry()
    const Page = () => null
    const facades = bootstrapCopy.createRouteManifestShardFacades<BackendRouteManifestEntry>(
      'backend',
      [{ moduleId: 'sales', pattern: '/backend/sales' }, { moduleId: 'customers', pattern: '/backend/customers' }],
      ['sales', 'customers'],
    )

    await expect(facades[1].load()).rejects.toThrow('route shard "customers" is not registered')
    pageBundleCopy.registerRouteManifestShard('backend', 'customers', {
      routes: [{ moduleId: 'customers', pattern: '/backend/customers', load: async () => Page }],
      routeOrders: [1],
    })
    await expect(facades[1].load()).resolves.toBe(Page)
  })
})

