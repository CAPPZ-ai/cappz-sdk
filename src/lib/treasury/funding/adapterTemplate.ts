/**
 * COPE node crystallized. Node ID: v15-20-01-platform-adapter-template
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Platform adapter config templates: for each service an app depends on
 * (XRPL access, notices, the scheduler, fiat on-ramps…), a list of
 * interchangeable endpoints with a priority and weight. Lower priority is
 * tried first; within a priority, endpoints share load by weight. A failing
 * endpoint is skipped until its back-off ends. Nothing here names a hosting
 * provider: a template is data, and any platform can supply its own.
 */

export interface EndpointSpec {
  id: string;
  /** URL, or an opaque locator the platform's port understands. */
  url: string;
  /** 0 is tried first. */
  priority: number;
  /** Share of load within its priority (default 1). */
  weight?: number;
  region?: string;
}

export interface PlatformAdapterTemplate {
  /** Template name, e.g. 'xrpl-public', 'self-hosted'. */
  platform: string;
  services: Record<string, EndpointSpec[]>;
}

/** Back-off state per endpoint id: skip until `until` (epoch ms). */
export type EndpointHealth = Record<string, { until: number; failures: number }>;

/** FNV-1a: a stable seed → spread, so the same caller keeps the same order (cache-friendly) while callers spread out. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** The order to try endpoints in: healthy first (by priority, weighted by seed), backed-off last. */
export function endpointOrder(specs: readonly EndpointSpec[], health: EndpointHealth = {}, seed = '', now = Date.now()): EndpointSpec[] {
  const down = (e: EndpointSpec) => (health[e.id]?.until ?? 0) > now;
  // Weighted order without randomness: smaller key first, key = -ln(u)/w with u from the seed.
  const key = (e: EndpointSpec) => {
    const u = (hash32(`${seed}|${e.id}`) + 1) / 4294967297;
    return -Math.log(u) / Math.max(1e-9, e.weight ?? 1);
  };
  return [...specs].sort((a, b) => Number(down(a)) - Number(down(b)) || a.priority - b.priority || key(a) - key(b));
}

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

export function markFailed(health: EndpointHealth, id: string, now = Date.now()): EndpointHealth {
  const failures = (health[id]?.failures ?? 0) + 1;
  return { ...health, [id]: { failures, until: now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)) } };
}

export function markHealthy(health: EndpointHealth, id: string): EndpointHealth {
  if (!health[id]) return health;
  const { [id]: _, ...rest } = health;
  return rest;
}

/**
 * Run `call` against the service's endpoints in order until one succeeds.
 * Returns the result and the updated health; throws the last error if all fail.
 */
export async function withFailover<T>(
  specs: readonly EndpointSpec[],
  call: (e: EndpointSpec) => Promise<T>,
  o: { health?: EndpointHealth; seed?: string; now?: () => number } = {},
): Promise<{ result: T; endpoint: EndpointSpec; health: EndpointHealth }> {
  const now = o.now ?? Date.now;
  let health = o.health ?? {};
  let last: unknown = new Error('No endpoints configured');
  for (const e of endpointOrder(specs, health, o.seed, now())) {
    try {
      const result = await call(e);
      return { result, endpoint: e, health: markHealthy(health, e.id) };
    } catch (err) {
      last = err;
      health = markFailed(health, e.id, now());
    }
  }
  throw last;
}

export function templateProblems(t: PlatformAdapterTemplate): string[] {
  const out: string[] = [];
  for (const [svc, specs] of Object.entries(t.services)) {
    if (specs.length === 0) out.push(`${svc}: no endpoints`);
    const ids = new Set<string>();
    for (const e of specs) {
      if (ids.has(e.id)) out.push(`${svc}: duplicate endpoint id ${e.id}`);
      ids.add(e.id);
      if (!(e.priority >= 0)) out.push(`${svc}/${e.id}: priority must be 0 or more`);
      if (e.weight !== undefined && !(e.weight > 0)) out.push(`${svc}/${e.id}: weight must be positive`);
    }
  }
  return out;
}

/**
 * Starting templates. `xrpl-public` uses public XRPL servers (replace or add
 * your own). `self-hosted` assumes your own rippled pair and edge node.
 * Notices and the scheduler default to the device itself (`local:`), so an
 * app runs with no hosted service at all.
 */
export const PLATFORM_ADAPTER_TEMPLATES: Readonly<Record<string, PlatformAdapterTemplate>> = {
  'xrpl-public': {
    platform: 'xrpl-public',
    services: {
      xrpl: [
        { id: 'xrplcluster', url: 'wss://xrplcluster.com', priority: 0, weight: 2 },
        { id: 'ripple-s1', url: 'wss://s1.ripple.com', priority: 0, weight: 1 },
        { id: 'ripple-s2', url: 'wss://s2.ripple.com', priority: 1, weight: 1 },
      ],
      notify: [{ id: 'device', url: 'local:notify', priority: 0 }],
      scheduler: [{ id: 'edge-node', url: 'local:edge-node', priority: 0 }, { id: 'browser', url: 'local:browser', priority: 1 }],
    },
  },
  'self-hosted': {
    platform: 'self-hosted',
    services: {
      xrpl: [
        { id: 'rippled-a', url: 'wss://rippled-a.example.internal', priority: 0, weight: 1 },
        { id: 'rippled-b', url: 'wss://rippled-b.example.internal', priority: 0, weight: 1 },
        { id: 'public-fallback', url: 'wss://xrplcluster.com', priority: 1 },
      ],
      notify: [{ id: 'device', url: 'local:notify', priority: 0 }],
      scheduler: [{ id: 'edge-node', url: 'local:edge-node', priority: 0 }],
    },
  },
};
