/**
 * COPE node crystallized.
 * Node ID: v15-37-00-saml-wizard
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * The SAML Guard rollout, step by step — run without arguments for the guided
 * wizard, or one step at a time from scripts and CI:
 *
 *   deno run -A packages/cappz-edge-node/tools/saml-wizard.ts            # guided
 *   saml-wizard.ts keygen                                  1. operator key (signs pins and mode changes)
 *   saml-wizard.ts init --upstream http://127.0.0.1:8080   2. config skeleton
 *   saml-wizard.ts add-tenant --id acme --metadata acme-idp.xml \
 *       --acs https://app.example.com/saml/acs/acme --sp-entity https://app.example.com/saml/acme
 *                                                          3. a tenant from its IdP metadata, pins signed for it
 *   saml-wizard.ts doctor                                  4. configuration checks (exit 1 on errors)
 *   saml-wizard.ts test --tenant acme --response captured.b64 [--at 2026-11-09T12:00:00Z]
 *                                                          5. check a captured response offline
 *   (run the guard: saml-guard.ts --config … --upstream … — shadow by default)
 *   saml-wizard.ts status [--alert]                        6. per-tenant findings and enforce gate (exit 1 on new alerts)
 *   saml-wizard.ts enforce --tenant acme                   7. signed switch to enforce, citing the report
 *   saml-wizard.ts shadow --tenant acme --reason "…"        rollback, signed
 *   saml-wizard.ts rotate --tenant acme --metadata new.xml   pin the IdP's next certificate (old pins expire on their own)
 *   saml-wizard.ts monitor                                 8. scheduled checks (systemd timers / cron) for alerts and reconciliation
 *
 * Common flags: --dir ./saml-guard (holds saml.json, operator.key, data/), --url http://127.0.0.1:41451.
 * Nothing here talks to the IdP or the SaaS except `status`/`enforce` (the running guard's report).
 */
import { declareIdpPin, signTenantMode, createSamlGuard, decodeSamlResponse, type IdpPin, type SamlMultiReport, type SamlGateReport } from '../../../src/lib/identity/samlGuard.ts';
import { idpFromMetadata, lintSamlTenants, type LintReport } from '../../../src/lib/identity/samlTenants.ts';
import { importSigningKey, type SigningKey } from '../../../src/lib/sync/helloSignature.ts';
import { tenantsFromFile, readJsonl, type SamlConfigFile } from '../samlGuard.ts';

const args = Deno.args;
const flag = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const has = (n: string) => args.includes(`--${n}`);
const dir = flag('dir', './saml-guard')!;
const P = { config: `${dir}/saml.json`, key: `${dir}/operator.key`, data: `${dir}/data`, pins: `${dir}/data/saml-idp-pins.json`, modes: `${dir}/data/saml-tenant-modes.jsonl`, alerts: `${dir}/data/saml-alerts.jsonl`, alertOffset: `${dir}/data/saml-alerts.offset` };
const url = flag('url', 'http://127.0.0.1:41451')!;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const say = (s = '') => console.log(s);
const exists = (p: string) => Deno.stat(p).then(() => true, () => false);

async function readConfig(): Promise<SamlConfigFile> {
  try { return JSON.parse(await Deno.readTextFile(P.config)); } catch { throw new Error(`no config at ${P.config} — run: saml-wizard init`); }
}
const writeConfig = (c: SamlConfigFile) => Deno.writeTextFile(P.config, JSON.stringify(c, null, 2) + '\n');
const readPins = async (): Promise<IdpPin[]> => JSON.parse(await Deno.readTextFile(P.pins).catch(() => '[]'));
const writePins = (p: IdpPin[]) => Deno.writeTextFile(P.pins, JSON.stringify(p, null, 2) + '\n');

async function operatorKey(): Promise<SigningKey> {
  const env = Deno.env.get('CAPPZ_SAML_OPERATOR_KEY'); // "pkcs8base64:pubhex" — e.g. from a secret store
  const raw = env ?? await Deno.readTextFile(P.key).catch(() => '');
  const [pkcs8, pub] = raw.trim().split(':');
  if (!pkcs8 || !pub) throw new Error(`no operator key — run: saml-wizard keygen (or set CAPPZ_SAML_OPERATOR_KEY)`);
  return importSigningKey(pkcs8, pub);
}

// ─── Steps ────────────────────────────────────────────────────────

async function keygen() {
  await Deno.mkdir(dir, { recursive: true });
  if (await exists(P.key)) { say(`operator key already at ${P.key} (public: ${(await operatorKey()).publicKeyHex})`); return; }
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pkcs8 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))));
  const pub = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  await Deno.writeTextFile(P.key, `${pkcs8}:${pub}\n`, { mode: 0o600, createNew: true });
  say(`operator key written to ${P.key} (mode 600). Public key: ${pub}`);
  say('Keep the private key off the guard host if you can (CAPPZ_SAML_OPERATOR_KEY from a secret store when signing); the guard only needs the public key.');
}

async function init() {
  await Deno.mkdir(P.data, { recursive: true });
  if (await exists(P.config)) { say(`config already at ${P.config}`); return; }
  const pub = await operatorKey().then((k) => k.publicKeyHex).catch(() => null);
  const cfg: SamlConfigFile = {
    upstream: flag('upstream', 'http://127.0.0.1:8080'),
    trustedPinSigners: pub ? [pub] : [],
    defaults: { signature: 'builtin', requireSignedAssertion: true, allowUnsolicited: false, encryptedAssertions: 'refuse', maxLifetimeSec: 600, clockSkewSec: 120 },
    tenants: [],
  };
  await writeConfig(cfg);
  say(`config written to ${P.config} with strict defaults (built-in signature check, signed assertions, SP-initiated only).`);
  if (!pub) say('No operator key yet: run keygen, then add its public key to trustedPinSigners.');
}

async function readMetadata(src: string): Promise<string> {
  if (/^https:\/\//.test(src)) { const r = await fetch(src); if (!r.ok) throw new Error(`metadata ${src}: HTTP ${r.status}`); return r.text(); }
  if (/^http:\/\//.test(src)) throw new Error('fetch IdP metadata over https only (or download it and pass the file)');
  return Deno.readTextFile(src);
}

async function pinFrom(metadataSrc: string, tenantId: string, idpEntityIdExpected?: string) {
  const md = await idpFromMetadata(await readMetadata(metadataSrc));
  if (idpEntityIdExpected && md.entityId !== idpEntityIdExpected) throw new Error(`metadata is for ${md.entityId}, tenant ${tenantId} trusts ${idpEntityIdExpected}`);
  const key = await operatorKey();
  const days = Number(flag('days', '0'));
  const pins: IdpPin[] = [];
  for (const c of md.signingCertificates) {
    const certEnd = c.notAfter ? Date.parse(c.notAfter) : Date.now() + 365 * 86400_000;
    const expiresAt = new Date(days ? Math.min(certEnd, Date.now() + days * 86400_000) : certEnd).toISOString();
    if (Date.parse(expiresAt) <= Date.now()) { say(`  skipped certificate ${c.sha256.slice(0, 12)}… (expired ${c.notAfter})`); continue; }
    pins.push(await declareIdpPin({ idpEntityId: md.entityId, certificate: c.certificate, expiresAt, tenantId }, key));
    say(`  pinned ${c.sha256.slice(0, 12)}… for ${tenantId} until ${expiresAt}`);
  }
  return { md, pins };
}

async function addTenant() {
  const id = flag('id'); const metadata = flag('metadata'); const acs = flag('acs'); const sp = flag('sp-entity');
  if (!id || !metadata || !acs || !sp) throw new Error('add-tenant needs --id --metadata <file|https URL> --acs <url> --sp-entity <id>');
  const cfg = await readConfig();
  cfg.tenants ??= [];
  if (cfg.tenants.some((t) => t.id === id)) throw new Error(`tenant ${id} exists (use rotate to change its pins)`);
  const { md, pins } = await pinFrom(metadata, id);
  cfg.tenants.push({ id, idpEntityId: md.entityId, spEntityId: sp, acsUrls: acs.split(',').map((s) => s.trim()), ...(has('allow-unsolicited') ? { allowUnsolicited: true } : {}) });
  await writeConfig(cfg);
  await writePins([...(await readPins()), ...pins]);
  say(`tenant ${id}: IdP ${md.entityId}, ACS ${acs}, SP entity ${sp}, ${pins.length} pin(s).`);
  if (!md.signedMetadata && !metadata.startsWith('https://')) say('  note: this metadata is unsigned and came from a file — confirm the certificate fingerprint with the customer out of band.');
  say('  Next: doctor, then test with a captured response, then run the guard in shadow.');
}

async function rotate() {
  const id = flag('tenant'); const metadata = flag('metadata');
  if (!id || !metadata) throw new Error('rotate needs --tenant and --metadata');
  const cfg = await readConfig(); const t = cfg.tenants?.find((x) => x.id === id);
  if (!t) throw new Error(`no tenant ${id}`);
  const { pins } = await pinFrom(metadata, id, t.idpEntityId);
  const existing = await readPins();
  const fresh = pins.filter((p) => !existing.some((e) => e.tenantId === id && e.certSha256 === p.certSha256));
  const kept = has('retire-old') ? existing.filter((e) => e.tenantId !== id || pins.some((p) => p.certSha256 === e.certSha256)) : existing;
  await writePins([...kept, ...fresh]);
  say(`${fresh.length} new pin(s) for ${id}${has('retire-old') ? '; pins for certificates no longer in the metadata removed' : '; old pins stay until they expire (both certificates verify during the IdP\'s rollover)'}.`);
}

async function doctor(quiet = false): Promise<LintReport> {
  const cfg = await readConfig(); const pins = await readPins();
  const { tenants, multi } = tenantsFromFile(cfg, pins);
  const r = await lintSamlTenants(tenants, { pins, trustedPinSigners: cfg.trustedPinSigners, multiTenant: multi });
  if (!quiet) {
    for (const f of r.findings) say(`${f.severity.toUpperCase().padEnd(5)} ${String(f.tenant).padEnd(12)} ${f.code}: ${f.message}\n      fix: ${f.fix}`);
    say(r.ok ? `\nno errors (${r.warnings} warning(s)).` : `\n${r.errors} error(s), ${r.warnings} warning(s): fix the errors before enforcing.`);
  }
  return r;
}

async function test() {
  const tenant = flag('tenant'); const file = flag('response');
  if (!tenant || !file) throw new Error('test needs --tenant and --response <file: XML, base64, or a captured form body>');
  let raw = (await Deno.readTextFile(file)).trim();
  if (raw.includes('SAMLResponse=')) raw = new URLSearchParams(raw).get('SAMLResponse') ?? '';
  const xml = raw.startsWith('<') ? raw : decodeSamlResponse(raw);
  if (!xml) throw new Error('not XML, base64 or a form body with SAMLResponse');
  const cfg = await readConfig(); const pins = await readPins();
  const { tenants, multi } = tenantsFromFile(cfg, pins, 'wizard-test');
  const g = createSamlGuard({ ...(multi ? { tenants } : { config: tenants[0] }), mode: 'shadow', upstream: () => Promise.resolve(new Response(null)) });
  const at = flag('at') ? Date.parse(flag('at')!) : Date.now();
  const v = await g.checkFor(multi ? tenant : tenants[0].id, xml, at);
  const { observed, ...shown } = v;
  say(JSON.stringify(shown, null, 2));
  say(v.allowed ? `PASS for ${tenant}.` : `REFUSED for ${tenant}: ${v.reason}${v.detail ? ` (${v.detail})` : ''}`);
  if (!v.allowed && observed) say(`the response names issuer(s) ${observed.issuers.join(', ')}, audience(s) ${observed.audiences.join(', ')}, recipient ${observed.recipient ?? '—'}`);
  if (!v.allowed && ['expired', 'stale', 'not-yet-valid'].includes(v.reason ?? '')) say('captured responses expire within minutes: pass --at <the time it was issued> to check everything else.');
  if (v.reason === 'unsolicited') say('an IdP-initiated login (no InResponseTo): this tenant is SP-initiated only. If its users start from the IdP\'s app tiles, set "allowUnsolicited": true on the tenant (the doctor will warn).');
  return v.allowed;
}

async function fetchReport(): Promise<SamlMultiReport | SamlGateReport> {
  const r = await fetch(`${url}/cappz/saml/report`).catch((e) => { throw new Error(`guard not reachable at ${url}: ${e.message}`); });
  if (!r.ok) throw new Error(`report: HTTP ${r.status}`);
  return r.json();
}
const asMulti = (r: SamlMultiReport | SamlGateReport): SamlMultiReport => ('tenants' in r ? r : { tenants: { default: { ...r, mode: 'shadow', crossTenant: 0 } }, unknownTenant: 0, reportHash: r.reportHash });

async function status(): Promise<boolean> {
  const rep = asMulti(await fetchReport());
  say('tenant        mode     responses  days  SP-accepted/guard-refused         cross-tenant  enforce');
  for (const [id, t] of Object.entries(rep.tenants)) {
    const refused = Object.entries(t.spAcceptedGuardRefused).map(([k, c]) => `${k}×${c}`).join(' ') || '—';
    say(`${id.padEnd(13)} ${t.mode.padEnd(8)} ${String(t.responses).padStart(9)}  ${t.days.toFixed(1).padStart(4)}  ${refused.padEnd(32)}  ${String(t.crossTenant).padStart(12)}  ${t.enforce.ready ? 'READY' : 'not yet'}`);
    if (!t.enforce.ready && has('verbose')) for (const b of t.enforce.because) say(`              · ${b}`);
  }
  if (rep.unknownTenant) say(`\n${rep.unknownTenant} response(s) posted to an ACS path no tenant URL matched (check Host / X-Forwarded-Proto at the proxy, or a probe).`);
  if (!has('alert')) return true;
  // New alerts since the last run: the SP accepted what the guard refused, or a cross-tenant attempt.
  const all = await readJsonl<Record<string, unknown>>(P.alerts);
  const from = Number(await Deno.readTextFile(P.alertOffset).catch(() => '0')) || 0;
  const fresh = all.slice(from);
  await Deno.writeTextFile(P.alertOffset, String(all.length));
  for (const a of fresh) say(`ALERT ${a.at} tenant=${a.tenant ?? 'default'} reason=${a.reason} sp=${a.sp ?? '—'} mode=${a.mode} ${a.detail ?? ''}`);
  say(fresh.length ? `\n${fresh.length} new alert(s): revoke sessions for the affected subject hashes, check the tenant's configuration, see docs/SAML_GUARD.md "When an alert fires".` : 'no new alerts.');
  return fresh.length === 0;
}

async function setMode(mode: 'enforce' | 'shadow') {
  const tenant = flag('tenant'); if (!tenant) throw new Error(`${mode} needs --tenant`);
  const key = await operatorKey();
  let reportHash: string | null = null; let reason = flag('reason', '')!;
  if (mode === 'enforce') {
    const lint = await doctor(true);
    const errs = lint.findings.filter((f) => f.severity === 'error' && (f.tenant === tenant || f.tenant === '*' || String(f.tenant).split(',').includes(tenant)));
    if (errs.length && !has('force')) throw new Error(`doctor has ${errs.length} error(s) for ${tenant} — fix them first:\n${errs.map((e) => `  ${e.code}: ${e.message}`).join('\n')}`);
    const t = asMulti(await fetchReport()).tenants[tenant];
    if (!t) throw new Error(`the running guard has no tenant ${tenant}`);
    if (!t.enforce.ready && !has('force')) throw new Error(`the shadow report is not ready for ${tenant}:\n${t.enforce.because.map((b) => `  · ${b}`).join('\n')}\n(--force --reason "…" records an override)`);
    if (!t.enforce.ready && !reason.trim()) throw new Error('--force needs --reason');
    reportHash = t.reportHash; reason ||= 'shadow report gate passed';
  } else if (!reason.trim()) throw new Error('shadow (rollback) needs --reason');
  const rec = await signTenantMode({ tenantId: tenant, mode, reason, reportHash }, key);
  await Deno.mkdir(P.data, { recursive: true });
  await Deno.writeTextFile(P.modes, JSON.stringify(rec) + '\n', { append: true });
  say(`${tenant} → ${mode} (signed by ${key.publicKeyHex.slice(0, 12)}…${reportHash ? `, report ${reportHash.slice(0, 12)}…` : ''}). The guard picks it up on its next request.`);
}

function monitor() {
  const deno = '/opt/cappz-edge-node/bin/deno'; const sdk = '/opt/cappz-edge-node/sdk';
  let abs = dir; try { abs = Deno.realPathSync(dir); } catch { /* not created yet */ }
  say(`# Two scheduled checks. Copy these to /etc/systemd/system/ and: systemctl enable --now cappz-saml-alerts.timer cappz-saml-reconcile.timer
# (or the cron lines at the end). Each exits non-zero on findings: wire OnFailure= to your paging (email, Slack webhook, PagerDuty).

# --- cappz-saml-alerts.service: every 5 min, new guard alerts (the SP accepted what the guard refused; cross-tenant attempts)
[Unit]
Description=CAPPZ SAML Guard alerts
OnFailure=cappz-saml-page@%n.service
[Service]
Type=oneshot
ExecStart=${deno} run --allow-read --allow-write --allow-net=127.0.0.1 ${sdk}/packages/cappz-edge-node/tools/saml-wizard.ts status --alert --dir ${abs}

# --- cappz-saml-alerts.timer
[Timer]
OnCalendar=*:0/5
Persistent=true
[Install]
WantedBy=timers.target

# --- cappz-saml-reconcile.service: daily, every SaaS login matched to an IdP issuance (export both logs first — see docs)
[Unit]
Description=CAPPZ SAML login reconciliation
OnFailure=cappz-saml-page@%n.service
[Service]
Type=oneshot
ExecStart=${deno} run --allow-read --allow-write ${sdk}/packages/cappz-edge-node/tools/saml-reconcile.ts --issued okta:/var/lib/cappz-saml/exports/okta.json --logins csv:/var/lib/cappz-saml/exports/saas.csv --logins-map /etc/cappz-saml/saas-map.json --out /var/lib/cappz-saml/reconcile-latest.json

# --- cappz-saml-reconcile.timer
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target

# --- cron instead:
# */5 * * * *  ${deno} run --allow-read --allow-write --allow-net=127.0.0.1 ${sdk}/packages/cappz-edge-node/tools/saml-wizard.ts status --alert --dir ${dir} || <your alert command>
# 15 6 * * *   ${deno} run --allow-read --allow-write ${sdk}/packages/cappz-edge-node/tools/saml-reconcile.ts … || <your alert command>`);
}

// ─── Guided wizard ────────────────────────────────────────────────

function ask(q: string, d?: string): string {
  const a = prompt(`${q}${d ? ` [${d}]` : ''}:`)?.trim();
  return a || d || '';
}
async function guided() {
  say('CAPPZ SAML Guard setup. Each step can also be run on its own (see --help). Ctrl+C to stop; nothing is enforced until step 7.\n');
  const step = async (title: string, run: () => Promise<unknown>) => { say(`\n── ${title}`); try { await run(); } catch (e) { say(`  ${(e as Error).message}`); } };
  await step('1. Operator key', keygen);
  await step('2. Configuration', async () => { if (!(await exists(P.config))) { args.push('--upstream', ask('Where does the SaaS app listen (the guard forwards there)', 'http://127.0.0.1:8080')); } await init(); });
  while (ask('\n3. Add a tenant now? (y/n)', (await readConfig()).tenants?.length ? 'n' : 'y').toLowerCase().startsWith('y')) {
    await step('3. Tenant', async () => {
      const id = ask('Tenant id (short, lowercase)'); const metadata = ask('IdP metadata (file path or https URL from the customer)');
      const acs = ask('This tenant\'s ACS URL (where its IdP posts)'); const sp = ask('This tenant\'s SP entity ID (as registered in its IdP)');
      args.push('--id', id, '--metadata', metadata, '--acs', acs, '--sp-entity', sp);
      await addTenant();
      for (const k of ['--id', '--metadata', '--acs', '--sp-entity']) { const i = args.indexOf(k); if (i >= 0) args.splice(i, 2); }
    });
  }
  await step('4. Doctor', () => doctor());
  if (ask('\n5. Test a captured SAMLResponse? (y/n)', 'n').toLowerCase().startsWith('y')) await step('5. Test', async () => { args.push('--tenant', ask('Tenant'), '--response', ask('File with the response'), '--at', ask('Time it was issued (ISO), or empty for now', new Date().toISOString())); await test(); });
  say(`\n── 6. Run the guard in shadow (the SaaS stays in charge):\n  deno run -A packages/cappz-edge-node/tools/saml-guard.ts --config ${P.config} --upstream ${(await readConfig()).upstream ?? 'http://127.0.0.1:8080'} --data ${P.data}\n  nginx: proxy_pass http://127.0.0.1:41451; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme;\n  Then watch: saml-wizard status --verbose`);
  say('\n── 7. Enforce a tenant when its report says READY: saml-wizard enforce --tenant <id>');
  say('\n── 8. Monitoring:'); monitor();
}

// ─── Dispatch ─────────────────────────────────────────────────────

const commands: Record<string, () => Promise<unknown> | unknown> = {
  keygen, init, 'add-tenant': addTenant, rotate, doctor: async () => (await doctor()).ok, test, status, enforce: () => setMode('enforce'), shadow: () => setMode('shadow'), monitor,
};
const cmd = args[0];
if (!cmd || cmd === 'wizard') await guided();
else if (cmd === '--help' || cmd === 'help') { const src = await Deno.readTextFile(new URL(import.meta.url)); say(src.slice(src.indexOf(' * The SAML'), src.indexOf(' */')).replace(/^ \* ?/gm, '')); }
else if (!commands[cmd]) { console.error(`unknown step ${cmd} — try --help`); Deno.exit(2); }
else {
  try { const ok = await commands[cmd](); if (ok === false) Deno.exit(1); }
  catch (e) { console.error((e as Error).message); Deno.exit(1); }
}
