/**
 * COPE node crystallized.
 * Node ID: v15-36-00-standalone-saml-guard
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Just SAML Guard, without the rest of the edge node.
 *
 *   deno run -A packages/cappz-edge-node/tools/saml-guard.ts --config saml.json \
 *     --upstream http://127.0.0.1:8080 --data ./node-data [--port 41451] [--enforce]
 *
 * Shadow by default: the SP stays authoritative and GET /cappz/saml/report lists every
 * response it accepted that the guard would have refused. Pin the IdP's signing
 * certificate with the operator's key first:
 *
 *   deno run -A packages/cappz-edge-node/tools/saml-guard.ts pin --idp <entityId> \
 *     --cert idp.pem --days 365 --data ./node-data      (CAPPZ_NODE_KEY / CAPPZ_NODE_PUB, or your wallet key)
 */
import { serveSamlGuard } from '../samlGuard.ts';
import { declareIdpPin, type IdpPin } from '../../../src/lib/identity/samlGuard.ts';
import { loadNodeKey } from '../nodeKey.ts';

const flag = (n: string, d?: string) => { const i = Deno.args.indexOf(`--${n}`); return i >= 0 ? Deno.args[i + 1] : d; };
const data = flag('data', './node-data')!;
await Deno.mkdir(data, { recursive: true });

if (Deno.args[0] === 'pin') {
  const key = await loadNodeKey();
  if (!key) throw new Error('set CAPPZ_NODE_KEY and CAPPZ_NODE_PUB to the key that signs pins (list its public key in trustedPinSigners)');
  const idp = flag('idp'); const cert = flag('cert');
  if (!idp || !cert) throw new Error('pin needs --idp <entityId> and --cert <file.pem>');
  const pin = await declareIdpPin({ idpEntityId: idp, certificate: await Deno.readTextFile(cert), expiresAt: new Date(Date.now() + Number(flag('days', '365')) * 86400_000).toISOString() }, key);
  const path = `${data}/saml-idp-pins.json`;
  const pins: IdpPin[] = await Deno.readTextFile(path).then((t) => JSON.parse(t)).catch(() => []);
  await Deno.writeTextFile(path, JSON.stringify([...pins.filter((p) => !(p.idpEntityId === idp && p.certSha256 === pin.certSha256)), pin], null, 2));
  console.log(`pinned ${pin.certSha256} for ${idp} until ${pin.expiresAt} (signer ${pin.signerKey})`);
} else {
  const config = flag('config'); const upstream = flag('upstream');
  if (config) Deno.env.set('CAPPZ_SAML_CONFIG', config);
  if (upstream) Deno.env.set('CAPPZ_SAML_UPSTREAM', upstream);
  if (Deno.args.includes('--enforce')) Deno.env.set('CAPPZ_SAML_MODE', 'enforce');
  await serveSamlGuard(Number(flag('port', '41451')), data);
}
