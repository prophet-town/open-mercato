# Per-shard backend routes: experiment report

Branch `experiment/per-module-backend-routes`, cut from `main` at `bab96cecf`. The code is in `07e7e584e` (the change), `6430f6229` (two fixes found while measuring) and `5d5d2f5dc` (comment wording). Everything ran locally on an M-series Mac, Node 24.22.3, Next 16 with Turbopack. Commands ran in local mode: no compose `app` container was running.

The measuring scripts are in `.ai/runs/route-split-tools/`. `entry.js` and `measure.mjs` are adapted from Talaria's bundle audit; `dev-measure.mjs`, `nav.mjs`, `vitals.mjs`, `server.mjs` and `lh.mjs` were written for this experiment. Raw logs and JSON results stayed on the machine that ran them.

## Summary

- Every backend module page shared one client entry of 38.1 MB raw / 7.05 MB gzip. With one generated route per shard key, a module page's entry is 12.4 to 17.5 MB raw (median 12.5) and 2.05 to 4.27 MB gzip.
- In Chromium with a cold cache, a backend module page transfers 3.7 to 3.9 MB instead of 8.4 MB (−54 to −56%) and decodes 22 to 23 MB instead of 44 MB. A public page (`/terms`) transfers 2.7 MB instead of 7.7 MB (−65%).
- Half of the problem was not the catch-all. Bootstrap's generated route registrations imported every backend and frontend page loader, so every route that runs bootstrap carried every page. Fixing that is what shrank the frontend catch-all.
- Dev: the first hit on a module page is about twice as fast (11.3 to 12.0 s instead of 17.8 to 22.1 s). Each further module that has not been visited yet costs about 5 s of compile, where the single catch-all paid once. Peak memory did not rise.
- Production build time is unchanged. Build output grows: `.mercato/next/static` +81%, `.mercato/next/server` +66%.
- Unit tests, typechecks and the integration subset give identical results before and after.
- Recommendation: worth taking upstream as a spec, with the open points below settled first. The next lever is the ~10 MB floor that bootstrap's widget registries still put on every page.

## Design implemented

**Generated routes.** `mercato generate` groups backend pages by the existing shard key. The key is the first URL segment after `/backend`, the same key the `backend-route-shard.NNN.<key>.generated.ts` files already use. For each static key the generator writes one Next route:

```
src/app/(backend)/backend/(generated)/<key>/[[...slug]]/page.tsx
```

Each file is 18 lines. It imports its own shard file and registers it with `registerRouteManifestShard('backend', key, shard)`. It exports `generateMetadata`, a default page component and `dynamic = 'force-dynamic'`, all of which call a shared helper with the key as a path prefix. Next hands a `<key>/[[...slug]]` route only the segments after the key, so the helper rebuilds the full `/backend/<key>/...` path from that prefix.

Keys come from discovered routes, never from a list. This repo has 70. The `__root` and `__dynamic` keys get no page. If a `__dynamic` shard exists, every generated page also imports and registers it, so a route with a dynamic first segment still matches under a static prefix. This repo has no such route.

**Shared helper.** The body of `(backend)/backend/[...slug]/page.tsx` moved into `src/app/(backend)/backend/route-page.tsx` as `renderBackendRoute(props, routes, prefix)` and `resolveBackendRouteMetadata(props, routes, prefix)`. The logic is unchanged: route match, auth redirect, `requireRoles`, `requireFeatures` with organisation scope, page middleware, the component replacement handle, breadcrumbs and title metadata. Page overrides from `modules.ts` still apply in `registerBackendRouteManifests`. Generated pages pass `getBackendRouteManifests()`, which bootstrap fills.

**Root catch-all.** `(backend)/backend/[...slug]/page.tsx` stays. It registers the full `backendRouteFacades` and renders through the same helper. Next prefers the static `<key>` segment, so the root catch-all now receives only paths no shard claims: unknown paths, and keys the generator skipped because the app already has a `src/app/(backend)/backend/<key>` directory. Its entry is still 37.1 MB, but normal navigation never lands on it.

**Bootstrap no longer imports every page loader.** `bootstrap-common.ts` runs `bootstrap-registrations.generated.ts`. That file imported `backendRouteFacades`, whose loader is a `switch` of every shard `import()`, and `frontendRoutes`, which holds every frontend page `import()`. So every route that runs bootstrap had every page's client components in its entry, whatever the catch-all did. The frontend catch-all shows the effect: it was 38.1 MB, the same as the backend catch-all, because bootstrap gave it every backend page.

Bootstrap now registers metadata-only facades from two new generated files, `backend-route-registry.generated.ts` and `frontend-route-registry.generated.ts`. They are built from `backend-route-metadata.generated.ts` and a new `frontend-route-metadata.generated.ts`. A facade's `load()` looks up its shard in a `globalThis` map that page bundles fill (`createRouteManifestShardFacades` in `@open-mercato/shared/modules/registry`).

If the shard is not registered, the facade loads the same route from the last manifest registered with real loaders. `registerBackendRouteManifests` and `registerFrontendRouteManifests` remember any non-facade list they receive. The backend root catch-all, the frontend catch-all and any app still using the template's single catch-all register such a list. If neither source has the route, `load()` throws an `[internal]` error that names the route and the shard.

**Frontend.** The frontend catch-all keeps its full `frontendRoutes` import. It also registers those routes as the `frontend:__root` shard, because it bootstraps lazily and bootstrap re-registers facades. The frontend is not split per segment; see "Frontend split" below.

**Opt-in per app.** The generator writes pages only when `src/app/(backend)/backend/route-page.tsx` (or `.ts`) exists. The repo app and the create-app template both ship it. An app without it keeps the single catch-all and still gets the bootstrap change.

**Housekeeping.** `(generated)/` is in the root `.gitignore` and the template `gitignore`. `yarn clean:generated` removes it. `template-sync` ignores it. Each generate removes key directories that no longer have a shard. A page file is rewritten only when its content changes, so an unchanged generate does not trigger dev reloads.

### Where the generated route files live

Next routes only files under `src/app`, so the pages cannot live in `.mercato/generated`. They live in a route group, `src/app/(backend)/backend/(generated)/`, written in the same generator pass as the shard files they import.

- A route group does not change URLs. It keeps every generated file in one directory: one `.gitignore` line, one directory to delete.
- The group sits under `(backend)/backend/`, so it shares `layout.tsx` with the rest of the backend.
- Generated code now sits under `src/`. AGENTS.md reserves `apps/mercato/src/` for template boilerplate and committed generated registries. These files are gitignored, not committed. Committing them like the `*.generated.ts` registries is the alternative; it adds 70 files to every app's diff whenever a module is added.
- A fresh clone needs `generate` before it builds. That was already true: the root catch-all imports `.mercato/generated` files.
- A key whose directory the app already owns is skipped, to avoid Next's "two pages resolve to the same path" error. Its pages stay on the fat root catch-all.
- Shard keys are lower-cased. A route whose first segment has upper-case letters would not match its generated directory, because Next segments are case-sensitive. No such route exists here.
- In a standalone app, `mercato generate` already writes shard files that import module pages from `node_modules/@open-mercato/*/dist`. The generated page imports only that shard file and `../../../route-page`, so it does not care where module code comes from. Not tested in a scaffolded standalone app.

## Measurements

The repo's `next.config.ts` sets `turbopackMinify: false`, so all byte figures are for unminified client code. Both builds use the same config. "gzip" is `zlib` level 9 per file.

### 1. Production client JS

**Entry JS per route**, from each route's `page_client-reference-manifest.js` (`entryJSFiles`):

| Page / route | Before files | Before raw MB | Before gzip MB | After route | After files | After raw MB | After gzip MB | Δ gzip |
|---|---|---|---|---|---|---|---|---|
| customers (people) | 173 | 38.10 | 7.05 | `(generated)/customers` | 85 | 15.53 | 2.52 | −64% |
| definitions (workflows) | 173 | 38.10 | 7.05 | `(generated)/definitions` | 69 | 14.48 | 2.34 | −67% |
| staff (time tracking, team members) | 173 | 38.10 | 7.05 | `(generated)/staff` | 78 | 14.56 | 2.36 | −66% |
| sales | 173 | 38.10 | 7.05 | `(generated)/sales` | 71 | 13.94 | 2.27 | −68% |
| api-keys (smallest) | 173 | 38.10 | 7.05 | `(generated)/api-keys` | 64 | 12.39 | 2.05 | −71% |
| design-system (largest) | 173 | 38.10 | 7.05 | `(generated)/design-system` | 69 | 17.47 | 4.27 | −39% |
| backend root catch-all (fallback) | 173 | 38.10 | 7.05 | `(backend)/backend/[...slug]` | 167 | 37.11 | 6.93 | −2% |
| frontend catch-all | 176 | 38.11 | 7.04 | `(frontend)/[...slug]` | 73 | 13.79 | 2.23 | −68% |
| `/backend` dashboard | 26 | 2.44 | 0.43 | same | 26 | 2.44 | 0.43 | 0% |
| `/login` | 16 | 1.57 | 0.30 | same | 16 | 1.57 | 0.30 | 0% |
| `/start` | 170 | 38.07 | 7.04 | same | 170 | 38.07 | 7.04 | 0% |

Across all 70 generated routes: raw 12.35 / 12.46 / 17.47 MB and gzip 2.05 / 2.06 / 4.27 MB (min / median / max). Baseline brotli for the catch-all was 5.86 MB; brotli was skipped for the after run to keep the script under ten minutes.

**Cold page loads in Chromium.** Playwright with the cache cleared before every page, against `next start` in the ephemeral environment, gzip on the wire. Each page was measured twice per build; the two runs were byte-identical.

| Page (cold cache) | Before scripts | Before decoded MB | Before transferred MB | After scripts | After decoded MB | After transferred MB | Δ transferred |
|---|---|---|---|---|---|---|---|
| `/login` | 31 | 3.40 | 0.71 | 31 | 3.40 | 0.71 | 0% |
| `/backend` | 117 | 13.21 | 2.35 | 117 | 13.21 | 2.35 | 0% |
| `/backend/customers/people` | 237 | 44.30 | 8.43 | 151 | 23.20 | 3.92 | −54% |
| `/backend/definitions` (workflows) | 230 | 44.13 | 8.40 | 128 | 21.97 | 3.68 | −56% |
| `/backend/staff/time-tracking` | 230 | 44.13 | 8.40 | 137 | 22.05 | 3.71 | −56% |
| `/backend/staff/team-members` | 230 | 44.13 | 8.40 | 137 | 22.05 | 3.71 | −56% |
| `/terms` (frontend) | 181 | 39.71 | 7.67 | 78 | 15.39 | 2.68 | −65% |

**What is left on every module page.** The smallest generated route (`api-keys`, 12.39 MB) shares only 2.38 MB of entry files with the `/backend` dashboard route, which does not run bootstrap. So about 10 MB raw comes from bootstrap's own graph. `bootstrap.ts` imports `injection-widgets.generated.ts` (85 widget `import()`s), `dashboard-widgets.generated.ts` (23) and `component-overrides.generated.ts`. The module's own pages add 0 to 5 MB on top (customers adds 4.5 MB, by chunk-file difference). I did not attribute the floor with source maps; the build has none, and adding them was out of scope.

### 2. Production build time and output size

`next build` in `apps/mercato` after `rm -rf .mercato/next` (cold), then a second build (warm):

| | Before | After |
|---|---|---|
| Cold build total | 133 s | 127 s |
| Cold compile / TypeScript | 42 s / 85 s | 44 s / 77 s |
| Warm build total | 28 s | 34 s |
| Warm compile / TypeScript | 10.7 s / 10.7 s | 14.4 s / 12.0 s |
| `.mercato/next/static` | 103.3 MB | 186.6 MB (+81%) |
| `.mercato/next/server` | 605.8 MB | 1003.4 MB (+66%) |
| `.mercato/next/cache` | 1221.4 MB | 1833.9 MB |
| `.mercato/next` total | 1931.7 MB | 3025.6 MB |

Cold time is within noise. The warm build is 6 s slower. Output grows because Turbopack copies shared modules into each route's chunks, and there are 70 more routes. Together, `static` and `server` grow by 481 MB on disk, `.map` files included.

### 3. Dev server

Method: `yarn dev:app` on port 3000 against the ephemeral database, after `rm -rf apps/mercato/.mercato/next/dev`. The dev runtime precompiles `/login` and the login API at start. Its own login then fails (it uses the superadmin credentials from `.env`), so it skips `/backend`; this happened identically in every run. `dev-measure.mjs` then logs in as `admin@acme.com` and fetches `/backend/customers/people`, `/backend/staff/time-tracking` and `/backend/customers/people` again, with auth cookies. Compile times come from Next's trace (`compile-path`). RSS is sampled every 500 ms.

Run 2 is the cleaner protocol: a fixed 90 s wait after warmup, and RSS summed over the whole `dev-cold.sh` process tree. Run 1 sampled only the process listening on :3000; in the baseline run 1 that server had restarted after warmup, so its absolute RSS is not comparable.

| | Before, run 1 | Before, run 2 | After, run 1 | After, run 2 |
|---|---|---|---|---|
| First `/backend/customers/people` | 22.1 s | 17.8 s | 12.0 s | 11.3 s |
| Its `compile-path` | 18.2 s (`/backend/[...slug]`) | 13.9 s | 8.9 s (`/backend/customers/[[...slug]]`) | 8.5 s |
| Then `/backend/staff/time-tracking` | 0.63 s | 0.56 s | 6.6 s | 6.5 s |
| Its `compile-path` | none | none | 5.0 s (`/backend/staff/[[...slug]]`) | 4.8 s |
| People again | 0.36 s | 0.35 s | 0.49 s | 0.45 s |
| Login API `compile-path` (warmup) | 10.3 s | 9.1 s | 4.1 s | 4.1 s |
| RSS peak during the hits | 4.49 GB (listener only) | 6.94 GB (tree) | 5.64 GB (listener only) | 6.60 GB (tree) |
| Dev runtime's reported peak | 5.9 GB | 6.3 GB | 5.5 GB | 6.0 GB |

- The first module page compiles about twice as fast, because its route reaches one shard instead of all of them.
- Every module page that has not been visited yet costs another 5 s or so. With the single catch-all, everything after the first page was free. Opening ten different modules in a fresh dev session costs roughly 50 s more in total.
- The login API compiles in less than half the time. The API route runs bootstrap too, and bootstrap no longer reaches every page loader.
- Peak memory did not rise with two modules open; it was slightly lower in both runs. I did not measure a session that visits many modules, which is where per-route compile state could add up.

### 4. Tests

| Check | Before | After |
|---|---|---|
| `@open-mercato/cli` unit tests | 2606 passed | 2608 passed (2 new) |
| `@open-mercato/shared` unit tests | 3354 passed, 35 skipped | 3356 passed, 35 skipped (2 new) |
| `@open-mercato/app` unit tests | 836 passed | 836 passed |
| Typecheck: app, cli, shared | pass | pass |
| `yarn template:sync` | pass | pass |
| `scripts/__tests__/clean-scripts.test.mjs` | not run | 4 passed |
| ESLint, app and changed package files | not run | 0 errors; 10 warnings, all in files this change does not touch |
| Integration subset | 454 passed, 2 failed, 15 skipped (13.4 min) | 454 passed, 2 failed, 15 skipped (12.0 min) |

The integration subset is every spec under `modules/(example|auth|customer_accounts)/__integration__/`: 471 tests. It was run with `yarn test:integration:ephemeral` against a freshly built ephemeral environment. `example` covers page overrides (`TC-UMES-022`, `TC-UMES-023`), page middleware (`TC-EXAMPLE-013`) and component replacement. `auth` covers RBAC, access-denied pages and the sidebar. `customer_accounts` covers the portal pages served by the frontend catch-all. The full suite has about 1,850 spec files and was not run. The workflows, staff, customers and sales suites in particular were not run.

The same two tests fail before and after: `TC-START-001` (desktop and mobile), which looks for the self-service onboarding heading on `/start`. Nothing else failed or needed a retry in either run.

Unit test changes:

- Two generator tests in `route-manifest-shards.test.ts`. One checks a page per static shard that imports only its own shard and passes the path prefix. The other checks that every page registers a dynamic-prefix shard when one exists.
- Two `@open-mercato/shared` tests across bundle copies. One loads a facade through a registered shard. The other falls back to routes a catch-all registered with real loaders.
- Two `output-snapshots.test.ts` assertions that named bootstrap's old imports now name the facade files.
- The registry mock in `portal-org-binding.test.tsx`, in the app and the template, gained the new export.

### 5. Page speed, navigation and server cost

A second pair of ephemeral environments, one per build, each measured in the same order. Scripts: `vitals.mjs`, `nav.mjs`, `server.mjs` and `lh.mjs` in `.ai/runs/route-split-tools/`.

**Cold page load, throttled.** Chromium with 10 Mbit/s, 40 ms round trip and 4× CPU slowdown, cache cleared, median of 3 runs. LCP is largest contentful paint. TBT is total blocking time: the sum of each long task's time over 50 ms. Script time is the browser's JavaScript execution time from CDP. "Settled" is the end of the last long task or response before 2 s with neither.

| Page | LCP before → after | TBT before → after | Script time before → after | Settled before → after |
|---|---|---|---|---|
| `/backend/customers/people` | 7.7 → 3.7 s | 233 → 156 ms | 5.5 → 2.1 s | 8.7 → 5.2 s |
| `/backend/definitions` | 7.7 → 3.6 s | 131 → 95 ms | 5.3 → 1.7 s | 8.4 → 4.8 s |
| `/backend/staff/time-tracking` | 7.5 → 3.5 s | 135 → 113 ms | 5.2 → 1.7 s | 8.4 → 4.8 s |
| `/terms` | 0.36 → 0.37 s | 70 → 33 ms | 4.5 → 0.9 s | 7.1 → 2.9 s |

First contentful paint is about 0.37 s in every case, because the server-rendered HTML does not change. On `/terms` the text is the largest paint and arrives with the HTML, so LCP does not move, but the page stops working 4 s sooner.

Lighthouse (desktop preset) worked only on `/terms`: its cookie header did not authenticate the backend pages, which ended on `/login`. On `/terms`, time to interactive went from 7.6 to 2.1 s and page weight from 8.2 to 3.2 MB. The performance score went from 0.95 to 0.90, because Lighthouse's LCP went from 1.5 to 2.1 s. The Playwright runs above show no LCP change on `/terms`, so I read that as Lighthouse variance, unconfirmed.

**Navigating between modules.** One cold load of `/backend/customers/people`, then sidebar clicks through seven pages. Every click was a client-side navigation; none reloaded the document. "Visible" is the time from click until the new page's wrapper element is on screen.

| Click to | Throttled visible, before → after | Script downloaded, before → after |
|---|---|---|
| `/backend/customers/companies` (same module) | 244 → 236 ms | 0 → 0 MB |
| `/backend/sales/orders` (first sales page) | 198 → 614 ms | 0 → 0.34 MB |
| `/backend/catalog/products` (first catalog page) | 166 → 501 ms | 0.05 → 0.30 MB |
| `/backend/definitions` (first workflows page) | 252 → 801 ms | 0 → 0.49 MB |
| `/backend/staff/time-tracking` (first staff page) | 136 → 723 ms | 0 → 0.50 MB |
| `/backend/customers/people` (visited before) | 158 → 154 ms | 0 → 0 MB |
| `/backend/sales/quotes` (module visited before) | 162 → 154 ms | 0 → 0 MB |

Without throttling, on localhost, the same first-visit clicks take 53–81 ms before and 88–122 ms after. The first visit to each module now costs 0.3 to 0.5 MB and about half a second on a 10 Mbit/s connection. Later visits are as fast as before. The cold load that starts the session settles 3.4 s sooner throttled (8.6 → 5.3 s), so a session has to open about seven new modules before the extra clicks cost more than the faster first page saved.

**Server.** `next start`, one static page per shard key (68 pages), fetched twice in a row. RSS is the process tree listening on the port.

| | Before | After |
|---|---|---|
| RSS at start | 582 MB | 790 MB |
| RSS after first pass | 1022 MB | 1205 MB |
| RSS after second pass | 1013 MB | 1147 MB |
| RSS after 10 s idle | 857 MB | 921 MB |
| First pass, median / p90 / max response | 125 / 136 / 1063 ms | 141 / 164 / 665 ms |
| Second pass, median / p90 / max response | 121 / 149 / 192 ms | 113 / 124 / 141 ms |

The server holds about 60 to 180 MB more with every route loaded. The first request to each module is about 16 ms slower at the median, because each route loads its own bundle. Once loaded, responses are as fast or slightly faster. The start figure was taken right after `Ready`, so it may include warmup noise; I took one sample per build.

## Regressions found

- **Dev compile per module.** Each module visited for the first time in a dev session costs about 5 s of compile. The single catch-all paid about 14 to 18 s once. This is the regression the April spec's design avoided. Possible mitigation, untested: generate the per-shard routes only for production builds, and keep the single catch-all in `next dev`. I did not check whether the generator can tell a build from a dev-watch run today.
- **Build output size**: static +81%, server +66%, warm build +6 s.
- **Two bugs found by the measurements and fixed in `6430f6229`.** First, every module page returned 404, because the generated route lost the key segment. The unit tests did not catch it; the browser measurement did. Second, an app still on the single-catch-all template would have had its pages throw once a facade replaced the real loaders, which led to the fallback above. The fallback has unit tests only; no scaffolded standalone app was run.

## Open risks

**Backward compatibility** (see `BACKWARD_COMPATIBILITY.md`):

- `bootstrap-registrations.generated.ts` now registers facades instead of real loaders. `getBackendRouteManifests()[i].load()` and `getFrontendRouteManifests()[i].load()` throw in a process where neither a matching shard nor a real-loader manifest is registered: an API-only bundle, a worker, the CLI. No code in this repo calls `load()` on page manifests outside the catch-alls. Third-party modules might.
- New exports in `@open-mercato/shared/modules/registry`: `registerRouteManifestShard` and `createRouteManifestShardFacades`. They are additive, but `packages/shared/AGENTS.md` asks for a decision before adding a cross-package contract.
- New generated files, all additive: `backend-route-registry`, `frontend-route-metadata`, `frontend-route-registry`. `backend-route-shards.generated.ts` and `backendRouteFacades` are unchanged.
- Template changes: a new `route-page.tsx`, a slimmer backend root catch-all, and one added line in the frontend catch-all. They follow the template-sync rules.

**Standalone apps.** Opting in means copying `route-page.tsx` and the new root catch-all into the app. An app that only upgrades packages gets the bootstrap change and relies on the fallback. Neither path was tested in a scaffolded app (`yarn test:create-app` was not run).

**Overrides.**
- Page overrides behave as before: they apply when manifests are registered, and the subset's override tests pass.
- A page overridden with `null` drops out of matching, so its generated route returns 404 for that path, as before.
- Its code still ships, but only on the routes of its own shard key instead of on every page. Dropping nulled pages from the generated shards would need the generator to evaluate `modules.ts` overrides. Those can be gated on environment variables or applied programmatically, so I did not do it. The per-shard split already removes most of that cost.
- An override that supplies a replacement component imports it from `modules.ts`. `modules.ts` is in bootstrap's graph, so that component's client code still lands on every page.

**HMR and dev watch.**
- In dev, the generator writes and deletes route directories under `src/app` while `next dev` runs.
- Adding a module with a new first segment creates a new route; removing one deletes it.
- Not tested: whether the structural watcher path calls this generator step, and how Next dev reacts to a route directory appearing or disappearing mid-session.

**Frontend split.** Not done. 21 of the 41 frontend routes sit under the dynamic `[orgSlug]` portal prefix. A per-segment frontend route would have to import that dynamic shard into every frontend route, or serve static paths that could also match a portal route from the wrong route. After the bootstrap fix, the frontend catch-all is 13.8 MB. 8.5 MB of that is chunk files it shares with the smallest backend route, which is mostly the bootstrap floor. At most 5.3 MB is frontend-only, by chunk-file difference. Splitting the frontend would save less than shrinking the floor.

**`/start`.** It imports `modules.app.generated.ts` and `frontend-routes.generated.ts` directly, so it still carries every page (38.1 MB). Pointing it at the metadata files is a separate, small fix.

**Comparison with the April spec's rejected alternatives.**
- The spec rejected "physical Next routes for every module file" because of BC risk, generator-contract risk and the extensibility model.
- This change generates one route per discovered shard key, not per file, and keeps all routing logic in one helper and one manifest.
- It still adds generated physical routes, which is the generator-contract risk the spec named.
- It does not hard-code module groups.

## Recommendation

Yes, as an upstream spec, not as this branch. The client-side win is large and plain: a backend module page sends less than half the JavaScript it did, and the bootstrap fix alone helps public pages and API compile times. Before a pull request, decide:

1. Whether dev keeps the single catch-all (no per-module compile cost) while production builds use per-shard routes.
2. Whether generated routes are committed or gitignored.
3. Whether to accept the facade `load()` behaviour change in the global manifests, or keep real loaders there for non-page callers through some other path.
4. Whether to fix the bootstrap widget floor in the same spec. It is now the largest share of every module page: about 10 MB raw of 12.4 MB on the smallest one.

Then run the full integration suite and `yarn test:create-app` on the result.
