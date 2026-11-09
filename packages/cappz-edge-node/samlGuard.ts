/**
 * COPE node crystallized.
 * Node ID: v15-36-00-edge-node-saml-guard
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * --saml <port> (default 41451, runs when CAPPZ_SAML_CONFIG is set): SAML Guard
 * (src/lib/identity/samlGuard.ts) in front of a SAML service provider you host.
 * nginx sends the SP's traffic here; the guard forwards it to CAPPZ_SAML_UPSTREAM.
 *
 *   location / { proxy_pass http://127.0.0.1:41451; proxy_set_header Host $host; }
 *
 * CAPPZ_SAML_CONFIG: a JSON file
 *   { "idpEntityId": "...", "spEntityId": "...", "acsUrls": ["https://app/saml/acs"],
 *     "trustedPinSigners": ["<operator wallet signing key hex>"], "allowUnsolicited": true,
 *     "maxLifetimeSec": 600, "requireSignedAssertion": false }
 * Pins: <CAPPZ_NODE_DATA>/saml-idp-pins.json (declareIdpPin output, an array), re-read on change.
 * CAPPZ_SAML_MODE=shadow (default) | enforce. Shadow keeps the SP authoritative; GET
 * /cappz/saml/report answers the findings and the enforce gate (state persisted in
 * <CAPPZ_NODE_DATA>/saml-shadow.json every 30 s). Every verdict is appended to
 * <CAPPZ_NODE_DATA>/saml-verdicts.jsonl with a salted subject hash, never the NameID
 * (salt: <CAPPZ_NODE_DATA>/saml-subject-salt, made once).
 * Gate: CAPPZ_SAML_MIN_RESPONSES (500), CAPPZ_SAML_MIN_DAYS (7).
 */

import { createSamlGuard, DEFAULT_SAML_GATE, type IdpPin, type SamlGuardConfig } from '../../src/lib/identity/samlGuard.ts';
import type { ShadowState } from '../../src/lib/identity/shadowCompare.ts';

async function subjectSalt(dataDir: string): Promise<string> {
  const path = `${dataDir}/saml-subject-salt`;
  try { return (await Deno.readTextFile(path)).trim(); } catch { /* first run */ }
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  await Deno.writeTextFile(path, salt, { createNew: true }).catch(() => {});
  return (await Deno.readTextFile(path)).trim();
}

export async function samlGuardFor(dataDir: string) {
  const cfgPath = Deno.env.get('CAPPZ_SAML_CONFIG');
  const upstream = Deno.env.get('CAPPZ_SAML_UPSTREAM');
  if (!cfgPath || !upstream) throw new Error('SAML Guard needs CAPPZ_SAML_CONFIG and CAPPZ_SAML_UPSTREAM');
  const file = JSON.parse(await Deno.readTextFile(cfgPath)) as Omit<SamlGuardConfig, 'pins' | 'subjectSalt'>;
  for (const k of ['idpEntityId', 'spEntityId', 'acsUrls'] as const) if (!file[k] || (k === 'acsUrls' && !file.acsUrls.length)) throw new Error(`SAML Guard config: ${k} is required`);
  const pinsPath = `${dataDir}/saml-idp-pins.json`;
  const pins: IdpPin[] = [];
  const loadPins = async () => { try { pins.splice(0, pins.length, ...(JSON.parse(await Deno.readTextFile(pinsPath)) as IdpPin[])); } catch { /* none yet: embedded certificates are refused */ } };
  await loadPins();
  setInterval(loadPins, 60_000);
  const statePath = `${dataDir}/saml-shadow.json`;
  let state: ShadowState | undefined;
  try { state = JSON.parse(await Deno.readTextFile(statePath)); } catch { /* first run */ }
  const num = (k: string, d: number) => { const v = Deno.env.get(k); return v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d; };
  const mode = Deno.env.get('CAPPZ_SAML_MODE') === 'enforce' ? 'enforce' : 'shadow';
  const guard = createSamlGuard({
    config: { ...file, pins, subjectSalt: await subjectSalt(dataDir) },
    mode, upstream, shadowState: state,
    gate: { ...DEFAULT_SAML_GATE, minResponses: num('CAPPZ_SAML_MIN_RESPONSES', DEFAULT_SAML_GATE.minResponses), minDays: num('CAPPZ_SAML_MIN_DAYS', DEFAULT_SAML_GATE.minDays) },
    onVerdict: (v) => Deno.writeTextFile(`${dataDir}/saml-verdicts.jsonl`, JSON.stringify(v) + '\n', { append: true }).catch((e) => console.warn('[edge-node] SAML verdict not logged:', e?.message ?? e)),
  });
  setInterval(() => { Deno.writeTextFile(`${statePath}.tmp`, JSON.stringify(guard.state())).then(() => Deno.rename(`${statePath}.tmp`, statePath)).catch((e) => console.warn('[edge-node] SAML shadow state not saved:', e?.message ?? e)); }, 30_000);
  return { guard, mode, upstream };
}

export async function serveSamlGuard(port: number, dataDir: string): Promise<void> {
  const { guard, mode, upstream } = await samlGuardFor(dataDir);
  const hostname = Deno.env.get('CAPPZ_SAML_HOST') ?? '127.0.0.1';
  console.log(`[edge-node] SAML Guard ${hostname}:${port}  (${mode === 'enforce' ? 'ENFORCE →' : 'SHADOW of'} ${upstream}; report GET /cappz/saml/report)`);
  Deno.serve({ port, hostname }, (req) => guard.handle(req));
}
