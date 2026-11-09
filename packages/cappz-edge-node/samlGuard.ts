/**
 * COPE node crystallized.
 * Node ID: v15-36-00-edge-node-saml-guard (multi-tenant v15-37-00)
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * --saml <port> (default 41451, runs when CAPPZ_SAML_CONFIG is set): SAML Guard
 * (src/lib/identity/samlGuard.ts) in front of a SAML service provider you host —
 * one IdP, or every customer of a multi-tenant SaaS. nginx sends the SP's traffic
 * here (keep the Host header and X-Forwarded-Proto: the login URL picks the tenant);
 * the guard forwards to CAPPZ_SAML_UPSTREAM.
 *
 *   location / { proxy_pass http://127.0.0.1:41451; proxy_set_header Host $host;
 *                proxy_set_header X-Forwarded-Proto $scheme; }
 *
 * CAPPZ_SAML_CONFIG: the file tools/saml-wizard.ts writes —
 *   { "trustedPinSigners": ["<operator key hex>"], "defaults": { ...SamlGuardConfig fields },
 *     "tenants": [ { "id": "acme", "idpEntityId": "...", "spEntityId": "...", "acsUrls": ["https://..."] }, ... ] }
 *   (15.36 single-IdP files — idpEntityId/spEntityId/acsUrls at the top — still work.)
 * Pins: <data>/saml-idp-pins.json (array; tenant pins name their tenant), re-read every minute.
 * Modes: CAPPZ_SAML_MODE is the default (shadow); per-tenant changes are operator-signed
 * records in <data>/saml-tenant-modes.jsonl (saml-wizard enforce / shadow), re-read on change.
 * GET /cappz/saml/report: findings, cross-tenant attempts and the enforce gate per tenant
 * (state in <data>/saml-shadow.json every 30 s). Every verdict goes to <data>/saml-verdicts.jsonl
 * with a salted subject hash, never the NameID; refusals the SP accepted and cross-tenant
 * attempts also go to <data>/saml-alerts.jsonl (saml-wizard status --alert reads it).
 * Gate: CAPPZ_SAML_MIN_RESPONSES (500), CAPPZ_SAML_MIN_DAYS (7).
 */

import { createSamlGuard, DEFAULT_SAML_GATE, replaySamlTenantModes, type IdpPin, type SamlGuardConfig, type SamlTenant, type SamlTenantModeRecord } from '../../src/lib/identity/samlGuard.ts';
import type { ShadowState } from '../../src/lib/identity/shadowCompare.ts';

export interface SamlConfigFile {
  trustedPinSigners?: string[];
  defaults?: Partial<SamlGuardConfig>;
  tenants?: Array<SamlTenant>;
  // 15.36 single-IdP shape
  idpEntityId?: string; spEntityId?: string; acsUrls?: string[];
  [k: string]: unknown;
}

/** Tenants from a config file and pins (the same resolution the wizard's doctor uses). */
export function tenantsFromFile(file: SamlConfigFile, pins: IdpPin[], subjectSalt?: string): { tenants: SamlTenant[]; multi: boolean } {
  const trusted = file.trustedPinSigners ?? [];
  if (file.tenants) return { multi: true, tenants: file.tenants.map((t) => ({ ...file.defaults, ...t, pins, trustedPinSigners: t.trustedPinSigners ?? trusted, subjectSalt })) };
  const single = file as unknown as SamlGuardConfig;
  for (const k of ['idpEntityId', 'spEntityId', 'acsUrls'] as const) if (!single[k] || (k === 'acsUrls' && !single.acsUrls.length)) throw new Error(`SAML Guard config: ${k} is required (or a tenants list)`);
  return { multi: false, tenants: [{ ...single, id: 'default', pins, trustedPinSigners: single.trustedPinSigners ?? trusted, subjectSalt }] };
}

export async function subjectSalt(dataDir: string): Promise<string> {
  const path = `${dataDir}/saml-subject-salt`;
  try { return (await Deno.readTextFile(path)).trim(); } catch { /* first run */ }
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  await Deno.writeTextFile(path, salt, { createNew: true }).catch(() => {});
  return (await Deno.readTextFile(path)).trim();
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  return (await Deno.readTextFile(path).catch(() => '')).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}

export async function samlGuardFor(dataDir: string) {
  const cfgPath = Deno.env.get('CAPPZ_SAML_CONFIG');
  if (!cfgPath) throw new Error('SAML Guard needs CAPPZ_SAML_CONFIG');
  const file = JSON.parse(await Deno.readTextFile(cfgPath)) as SamlConfigFile;
  const upstream = Deno.env.get('CAPPZ_SAML_UPSTREAM') || (typeof file.upstream === 'string' ? file.upstream : '');
  if (!upstream) throw new Error('SAML Guard needs CAPPZ_SAML_UPSTREAM (or "upstream" in the config)');
  const pinsPath = `${dataDir}/saml-idp-pins.json`;
  const pins: IdpPin[] = [];
  const loadPins = async () => { try { pins.splice(0, pins.length, ...(JSON.parse(await Deno.readTextFile(pinsPath)) as IdpPin[])); } catch { /* none yet: nothing verifies, every response is refused */ } };
  await loadPins();
  setInterval(loadPins, 60_000);
  const { tenants, multi } = tenantsFromFile(file, pins, await subjectSalt(dataDir));
  const operators = [...new Set([...(file.trustedPinSigners ?? []), ...(Deno.env.get('CAPPZ_SAML_OPERATORS') ?? '').split(',').map((s) => s.trim()).filter(Boolean)])];

  // Per-tenant modes from the operator's signed records, re-read when the file changes.
  const modesPath = `${dataDir}/saml-tenant-modes.jsonl`;
  let modes: { mtime: number; map: Record<string, 'shadow' | 'enforce'> } = { mtime: -1, map: {} };
  const tenantModes = async () => {
    const mtime = await Deno.stat(modesPath).then((s) => s.mtime?.getTime() ?? 0).catch(() => 0);
    if (mtime !== modes.mtime) {
      const { modes: m, refused } = await replaySamlTenantModes(await readJsonl<SamlTenantModeRecord>(modesPath), operators);
      if (refused) console.warn(`[edge-node] SAML Guard: ${refused} mode record(s) not signed by a trusted operator were ignored`);
      modes = { mtime, map: Object.fromEntries(Object.entries(m).map(([k, r]) => [k, r.mode])) };
    }
    return modes.map;
  };

  const statePath = `${dataDir}/saml-shadow.json`;
  // v2 file: { v: 2, states, crossTenant }; older files hold the state(s) alone.
  let saved: Record<string, ShadowState> | ShadowState | undefined; let crossTenant: Record<string, number> | undefined;
  try { const f = JSON.parse(await Deno.readTextFile(statePath)); if (f?.v === 2) { saved = f.states; crossTenant = f.crossTenant; } else saved = f; } catch { /* first run */ }
  const num = (k: string, d: number) => { const v = Deno.env.get(k); return v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d; };
  const mode = Deno.env.get('CAPPZ_SAML_MODE') === 'enforce' ? 'enforce' : 'shadow';
  const append = (name: string, v: unknown) => Deno.writeTextFile(`${dataDir}/${name}`, JSON.stringify(v) + '\n', { append: true }).catch((e) => console.warn(`[edge-node] ${name} not written:`, e?.message ?? e));
  const guard = createSamlGuard({
    ...(multi ? { tenants, shadowStates: saved as Record<string, ShadowState> | undefined, crossTenantCounts: crossTenant } : { config: tenants[0], shadowState: saved as ShadowState | undefined }),
    mode, upstream, tenantModes,
    gate: { ...DEFAULT_SAML_GATE, minResponses: num('CAPPZ_SAML_MIN_RESPONSES', DEFAULT_SAML_GATE.minResponses), minDays: num('CAPPZ_SAML_MIN_DAYS', DEFAULT_SAML_GATE.minDays) },
    onVerdict: async (v) => {
      const { observed: _o, ...logged } = v;
      await append('saml-verdicts.jsonl', logged);
      // The two signals worth waking someone for: the SP took what the guard refused, and a cross-tenant attempt.
      if ((!v.allowed && v.sp === 'allow') || v.reason === 'cross-tenant') await append('saml-alerts.jsonl', logged);
    },
  });
  // Atomic save every 30 s and on shutdown, so a restart never loses the evidence the enforce gate counts.
  const save = () => Deno.writeTextFile(`${statePath}.tmp`, JSON.stringify({ v: 2, states: multi ? guard.states() : guard.state(), crossTenant: guard.crossTenantCounts() })).then(() => Deno.rename(`${statePath}.tmp`, statePath)).catch((e) => console.warn('[edge-node] SAML shadow state not saved:', e?.message ?? e));
  setInterval(save, 30_000);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) { try { Deno.addSignalListener(sig, () => { save().finally(() => Deno.exit(0)); }); } catch { /* signals unsupported (Windows SIGTERM) */ } }
  return { guard, mode, upstream, tenants: guard.tenants() };
}

export async function serveSamlGuard(port: number, dataDir: string): Promise<void> {
  const { guard, mode, upstream, tenants } = await samlGuardFor(dataDir);
  const hostname = Deno.env.get('CAPPZ_SAML_HOST') ?? '127.0.0.1';
  console.log(`[edge-node] SAML Guard ${hostname}:${port}  (${tenants.length} tenant(s), default ${mode === 'enforce' ? 'ENFORCE →' : 'SHADOW of'} ${upstream}; report GET /cappz/saml/report)`);
  Deno.serve({ port, hostname }, (req) => guard.handle(req));
}
