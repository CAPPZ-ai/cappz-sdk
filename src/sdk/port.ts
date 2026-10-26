/** Move a legacy app (PHP) off its runtime route by route (v15-12-00): inventory, route host, response shadow, cut-over. */
export { createRouteHost, defineRoute, notPorted, isPorted, compileRoutes, replayRouteModes, nginxLocations, routeKey } from '../lib/legacyPort/routeHost';
export type { PortedRoute, RouteContext, RouteMode, PortEffect, RouteHost, RouteHostOptions } from '../lib/legacyPort/routeHost';
export { compareResponses, createRouteShadow, mergeRouteStates, DEFAULT_CUTOVER_POLICY } from '../lib/legacyPort/responseShadow';
export type { CompareRules, CapturedResponse, Outcome, RouteShadowState, RouteReport, CutoverPolicy } from '../lib/legacyPort/responseShadow';
export { inventoryPhpApp, parseAccessLog, parseCrontab, planMarkdown, scaffoldRoutes, nginxSnippet, LIBRARY_MAP } from '../lib/legacyPort/phpInventory';
export type { Inventory, InventoryRoute, PhpSource, RouteUses, TableUse, CronEntry, Framework, Destination } from '../lib/legacyPort/phpInventory';
