/**
 * COPE node crystallized.
 * Node ID: v15-36-00-saml-reconcile-tool
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Find SaaS logins your identity provider never issued, from two log exports.
 * Read-only: nothing is sent anywhere, no change to the SaaS or the IdP.
 *
 *   deno run --allow-read --allow-write packages/cappz-edge-node/tools/saml-reconcile.ts \
 *     --issued okta:okta-system-log.json          # or entra:signins.json, or csv:adfs.csv / json:file.json with --issued-map
 *     --logins csv:saas-audit.csv --logins-map saas-map.json \
 *     [--apps apps.json] [--aliases aliases.json] [--window-min 5] [--out report.json]
 *
 * A map names the export's fields (dot paths):
 *   { "at": "timestamp", "subject": "user.email", "app": { "constant": "saas" },
 *     "where": { "event_type": "sso_login" }, "assertionId": "saml.assertion_id", "ip": "client_ip" }
 * apps.json maps both sides' application names to one id: { "Saas (Okta)": "saas", "saas": "saas" }.
 *
 * Tamper-evident issuance (run on the edge node as exports arrive):
 *   saml-reconcile.ts seal --issued okta:today.json --data ./node-data
 *     appends a signed, chained batch (hashed subjects) to <data>/saml-issued-batches.jsonl
 *   saml-reconcile.ts --sealed ./node-data --logins csv:saas.csv --logins-map m.json
 *     reconciles against the sealed chain (salt <data>/saml-subject-salt; signer CAPPZ_NODE_PUB or --trust <hex>)
 *
 * Exit code: 0 clean, 1 findings (orphan or reused logins), 2 gaps only — so a timer or CI can alert.
 */
import { reconcileSamlLogins, issuedFromOktaSystemLog, issuedFromEntraSignIns, issuedFromRecords, loginsFromRecords, parseCsv, sealIssuedBatch, openSealedBatches, hashLogins, type IssuedAssertion, type SealedIssuedBatch, type FieldMapping } from '../../../src/lib/identity/samlReconcile.ts';
import { loadNodeKey } from '../nodeKey.ts';

const flags = (n: string) => Deno.args.flatMap((a, i) => (a === `--${n}` ? [Deno.args[i + 1]] : []));
const flag = (n: string, d?: string) => flags(n)[0] ?? d;
const json = async <T>(p?: string): Promise<T | undefined> => (p ? JSON.parse(await Deno.readTextFile(p)) as T : undefined);

async function rows(spec: string): Promise<{ kind: string; rows: unknown[] }> {
  const [kind, ...rest] = spec.split(':'); const path = rest.join(':');
  const text = await Deno.readTextFile(path);
  if (kind === 'csv') return { kind, rows: parseCsv(text) };
  const parsed = text.trim().startsWith('[') || text.trim().startsWith('{') ? JSON.parse(text) : text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { kind, rows: Array.isArray(parsed) ? parsed : (parsed.value ?? parsed.data ?? [parsed]) };
}

async function issuedFrom(specs: string[]): Promise<IssuedAssertion[]> {
  const map = await json<FieldMapping>(flag('issued-map'));
  const out: IssuedAssertion[] = [];
  for (const spec of specs) {
    const { kind, rows: r } = await rows(spec);
    if (kind === 'okta') out.push(...issuedFromOktaSystemLog(r));
    else if (kind === 'entra') out.push(...issuedFromEntraSignIns(r));
    else if (map) out.push(...issuedFromRecords(r, map));
    else throw new Error(`--issued ${spec}: csv/json exports need --issued-map`);
  }
  return out;
}

const data = flag('data', './node-data')!;
const saltPath = `${data}/saml-subject-salt`;
const batchesPath = `${data}/saml-issued-batches.jsonl`;

if (Deno.args[0] === 'seal') {
  const key = await loadNodeKey();
  if (!key) throw new Error('seal needs CAPPZ_NODE_KEY and CAPPZ_NODE_PUB');
  await Deno.mkdir(data, { recursive: true });
  let salt: string;
  try { salt = (await Deno.readTextFile(saltPath)).trim(); } catch {
    salt = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    await Deno.writeTextFile(saltPath, salt, { createNew: true });
  }
  const existing = (await Deno.readTextFile(batchesPath).catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as SealedIssuedBatch);
  const batch = await sealIssuedBatch(await issuedFrom(flags('issued')), { salt, previous: existing.at(-1)?.batchHash ?? null, key, apps: await json(flag('apps')) });
  await Deno.writeTextFile(batchesPath, JSON.stringify(batch) + '\n', { append: true });
  console.log(`sealed ${batch.items.length} issuance(s) ${batch.from} → ${batch.to}: ${batch.batchHash}`);
  Deno.exit(0);
}

const loginMap = await json<FieldMapping>(flag('logins-map'));
if (!loginMap) throw new Error('--logins-map is required (which fields of the SaaS export are time, user, app)');
let logins = (await Promise.all(flags('logins').map(async (s) => loginsFromRecords((await rows(s)).rows, loginMap)))).flat();
const aliases = await json<Record<string, string>>(flag('aliases'));
let issued: IssuedAssertion[];
const sealedDir = flag('sealed');
if (sealedDir) {
  const batches = (await Deno.readTextFile(`${sealedDir}/saml-issued-batches.jsonl`)).split('\n').filter(Boolean).map((l) => JSON.parse(l) as SealedIssuedBatch);
  const trust = flags('trust').length ? flags('trust') : [Deno.env.get('CAPPZ_NODE_PUB') ?? ''];
  const opened = await openSealedBatches(batches, trust);
  if (!opened.ok) { console.error(`sealed issuance does not verify: ${opened.because}`); Deno.exit(1); }
  issued = opened.issued;
  logins = await hashLogins(logins, (await Deno.readTextFile(`${sealedDir}/saml-subject-salt`)).trim(), aliases);
} else issued = await issuedFrom(flags('issued'));

const report = await reconcileSamlLogins(issued, logins, { apps: await json(flag('apps')), aliases: sealedDir ? undefined : aliases, windowBeforeMs: Number(flag('window-min', '5')) * 60_000 });
const out = flag('out');
if (out) await Deno.writeTextFile(out, JSON.stringify(report, null, 2));
console.log(report.summary);
console.log(JSON.stringify(report.counts));
for (const f of report.findings.slice(0, 20)) console.log(`  ${f.state.padEnd(16)} ${f.at}  ${f.app}  ${f.subject}${f.ip ? `  ${f.ip}` : ''}  — ${f.because}`);
if (report.findings.length > 20) console.log(`  … ${report.findings.length - 20} more${out ? ` in ${out}` : ' (use --out)'}`);
console.log(`report ${report.reportHash}`);
Deno.exit(report.verdict === 'clean' ? 0 : report.verdict === 'findings' ? 1 : 2);
