import { getBackendRouteManifests, registerBackendRouteManifests } from '@open-mercato/shared/modules/registry'
import { backendRouteFacades } from '@/.mercato/generated/backend-route-shards.generated'
import { renderBackendRoute, resolveBackendRouteMetadata, type BackendRouteProps } from '../route-page'

registerBackendRouteManifests(backendRouteFacades)
const routes = getBackendRouteManifests()

export function generateMetadata(props: BackendRouteProps) {
  return resolveBackendRouteMetadata(props, routes)
}

export default function BackendCatchAll(props: BackendRouteProps) {
  return renderBackendRoute(props, routes)
}

export const dynamic = 'force-dynamic'
