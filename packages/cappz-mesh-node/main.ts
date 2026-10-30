/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-node-cli
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * cappz-mesh: run a resilience mesh node on a laptop, a Raspberry Pi or an
 * Android phone (Termux). Provision before the outage; run during it.
 *
 *   npm run mesh -- <command> [options]            (from the SDK checkout)
 *   node cappz-mesh.mjs <command> [options]        (from a go-kit: no install, no internet)
 *
 *   wallet                         create this device's wallet (prints the address)
 *   charter --name <name>          (authority) found a mesh: writes charter.json
 *   grant <address> --role <role>  (authority) coordinator | responder | member → grant-<address>.json
 *   join --charter <f> [--grant <f>]   provision this device for the mesh
 *   revoke-device [--declaration <f>]   sign a KeyZ revocation of a device key (a lost one: its declaration file + CAPPZ_MESH_PHRASE)
 *   revoke-member <grant file>     (authority) revoke a membership grant
 *   run [--alias <name>] [--port 41460] [--peer host:port]... [--channel alerts]... [--no-relay] [--no-discovery] [--web-port 41480] [--no-web]
 *   web-build                      bundle the phone app (web/app.js); done once, before the outage
 *   evals [--full] [--out report.md]   run the benchmark / eval suite
 *   quickstart [--charter <f>]     one step on a new device: wallet + join (guest) + run; from a kit, uses its charter.json
 *   apply-grant <file>             add a grant to an already-joined device
 *   kit-build [--out dist/cappz-mesh-kit] [--charter <f>] [--with-node all|linux-x64,...] [--sign]   build the go-kit
 *   verify-kit [<dir>] [--charter <f>]   check a kit's files and its authority signature
 *
 * Everything lives in --home (default ~/.cappz-mesh). The wallet phrase is the
 * root of this identity: keep the file private, or pass CAPPZ_MESH_PHRASE.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../../src/lib/auth/wallet/session.ts';
import { revokeKeyDeclaration, type KeyDeclaration, type KeyRevocation } from '../../src/lib/identity/keyDeclaration.ts';
import { utf8 } from '../../src/lib/identity/canonical.ts';
import { createCharter, grantMembership, revokeMembership, meshIdOf, verifyCharter, PRECEDENCE, type MeshCharter, type MeshMembership, type MeshMembershipRevocation, type Precedence } from '../../src/lib/mesh/meshIdentity.ts';
import { MeshNode, provisionMeshDevice, saveMeshDevice, loadMeshDevice, type SavedMeshDevice } from '../../src/lib/mesh/meshNode.ts';
import { writeCarryFile, readCarryFile } from '../../src/lib/mesh/meshCarry.ts';
import { runMeshEvals, formatEvalReport } from '../../src/lib/mesh/meshEvals.ts';
import { startIpMesh } from './ipLink.ts';
import { serveMeshWeb, MESH_WEB_PORT } from './webServe.ts';
import { buildKit, verifyKit, bundleMeshWeb, MESH_WEB_WORKER, NODE_PLATFORMS, type NodePlatform } from './kit.ts';
import { openSerialRadio } from './serialRadio.ts';
import { RadioMedium, loraTimeOnAirMs, loraBitRate } from '../../src/lib/mesh/meshRadio.ts';
import { LORA_REGIONS } from '../../src/lib/mesh/kiss.ts';
import { ContactBook, VoiceAssembler, decodeChat, textMessage, splitVoice, encodeChat, sanitizeAlias, EVERYONE_CHANNEL, GENERAL_CHANNEL, MAX_VOICE_MS } from '../../src/lib/mesh/meshChat.ts';
import { fileURLToPath } from 'node:url';
import { evaluateMembership } from '../../src/lib/mesh/meshIdentity.ts';

const argv = process.argv.slice(2).filter((a) => a !== '--');
const cmd = argv[0];
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const opts = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));
const home = opt('home') ?? path.join(os.homedir(), '.cappz-mesh');
const file = (n: string) => path.join(home, n);
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T;
const writePrivate = (p: string, v: unknown) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 }); };
const die = (m: string): never => { console.error(m); process.exit(1); };

function wallet() {
  const phrase = process.env.CAPPZ_MESH_PHRASE ?? (fs.existsSync(file('wallet.json')) ? readJson<{ phrase: string }>(file('wallet.json')).phrase : die('no wallet: run `wallet` first'));
  return keyPairFromPhrase(phrase);
}

async function main() {
  if (cmd === 'wallet') {
    if (fs.existsSync(file('wallet.json'))) die(`a wallet exists in ${home}`);
    const phrase = generateRecoveryPhrase();
    writePrivate(file('wallet.json'), { phrase });
    console.log(`wallet ${keyPairFromPhrase(phrase).address}\nphrase saved to ${file('wallet.json')} (0600). Write it on paper too: it is the only way to revoke this device if it is lost.`);
  } else if (cmd === 'charter') {
    const w = wallet();
    const charter = await createCharter(w.privateKey, { name: opt('name') ?? 'mesh', authorities: [w.address, ...opts('authority')] });
    const out = opt('out') ?? 'charter.json';
    fs.writeFileSync(out, JSON.stringify(charter, null, 2));
    console.log(`mesh ${await meshIdOf(charter)}\ncharter written to ${out}: give it to every member before the outage (file, QR).`);
  } else if (cmd === 'grant') {
    const w = wallet();
    const member = argv[1] ?? die('grant <member address> --role <role>');
    const role = (opt('role') ?? 'member') as MeshMembership['role'];
    if (!['coordinator', 'responder', 'member'].includes(role)) die('role: coordinator | responder | member');
    const charter = readJson<MeshCharter>(opt('charter') ?? 'charter.json');
    if (!charter.authorities.includes(w.address)) die('this wallet is not an authority of that charter');
    const grant = await grantMembership(w.privateKey, { meshId: await meshIdOf(charter), authority: w.address, member, role, ttlMs: Number(opt('days') ?? 180) * 86400_000 });
    const out = opt('out') ?? `grant-${member.slice(0, 12)}.json`;
    fs.writeFileSync(out, JSON.stringify(grant, null, 2));
    console.log(`${role} grant for ${member} written to ${out}`);
  } else if (cmd === 'join') {
    const w = wallet();
    const charter = readJson<MeshCharter>(opt('charter') ?? die('join --charter <file> [--grant <file>]'));
    if ((await verifyCharter(charter)) !== 'valid') die('charter signature does not verify');
    const grant = opt('grant') ? readJson<MeshMembership>(opt('grant')!) : undefined;
    if (grant && grant.member !== w.address) die('that grant names another wallet');
    const id = await provisionMeshDevice({ walletPrivateKey: w.privateKey, walletAddress: w.address, grant });
    fs.copyFileSync(opt('charter')!, file('charter.json'));
    writePrivate(file('device.json'), await saveMeshDevice(await meshIdOf(charter), id));
    // Public: keep a copy with the paper phrase, so this device can be revoked without it.
    fs.writeFileSync(file('device-declaration.json'), JSON.stringify(id.credentials.decl, null, 2));
    console.log(`joined mesh ${charter.name} as ${grant?.role ?? 'guest'}; device key ${id.deviceKey.publicKeyHex.slice(0, 16)}…`);
  } else if (cmd === 'revoke-device') {
    const w = wallet();
    const decl = opt('declaration') ? readJson<KeyDeclaration>(opt('declaration')!) : readJson<SavedMeshDevice>(file('device.json')).credentials.decl as KeyDeclaration;
    if (decl.walletAddress !== w.address) die('that declaration was made by another wallet: use its owner\'s phrase');
    const r = await revokeKeyDeclaration(w.privateKey, decl, opt('reason') ?? 'device lost');
    const out = opt('out') ?? 'revocation.json';
    fs.writeFileSync(out, JSON.stringify(r, null, 2));
    console.log(`revocation written to ${out}: hand it to any running node (/revoke ${out}) or carry it on a stick (import).`);
  } else if (cmd === 'revoke-member') {
    const w = wallet();
    const grant = readJson<MeshMembership>(argv[1] ?? die('revoke-member <grant file>'));
    const charter = readJson<MeshCharter>(opt('charter') ?? 'charter.json');
    if (!charter.authorities.includes(w.address)) die('this wallet is not an authority of that charter');
    const r = await revokeMembership(w.privateKey, grant, w.address, opt('reason') ?? 'membership withdrawn');
    const out = opt('out') ?? 'membership-revocation.json';
    fs.writeFileSync(out, JSON.stringify(r, null, 2));
    console.log(`membership revocation written to ${out}: load it into any running node (/revoke ${out}).`);
  } else if (cmd === 'quickstart') {
    // A device that was never provisioned: a wallet, the kit's charter, join as a guest, run.
    if (!fs.existsSync(file('wallet.json')) && !process.env.CAPPZ_MESH_PHRASE) {
      const phrase = generateRecoveryPhrase();
      writePrivate(file('wallet.json'), { phrase });
      console.log(`new wallet ${keyPairFromPhrase(phrase).address}\nWRITE THESE 24 WORDS ON PAPER (the only way to revoke this device if lost):\n${phrase}\n`);
    }
    if (!fs.existsSync(file('device.json'))) {
      const cf = opt('charter') ?? [path.join(here, 'charter.json'), 'charter.json'].find((f) => fs.existsSync(f)) ?? die('no charter.json: pass --charter <file> (ask a coordinator, or copy it from any member)');
      const charter = readJson<MeshCharter>(cf);
      if ((await verifyCharter(charter)) !== 'valid') die('charter signature does not verify');
      const w = wallet();
      const id = await provisionMeshDevice({ walletPrivateKey: w.privateKey, walletAddress: w.address });
      fs.writeFileSync(file('charter.json'), JSON.stringify(charter, null, 2));
      writePrivate(file('device.json'), await saveMeshDevice(await meshIdOf(charter), id));
      fs.writeFileSync(file('device-declaration.json'), JSON.stringify(id.credentials.decl, null, 2));
      console.log(`joined mesh "${charter.name}" (id ${(await meshIdOf(charter)).slice(0, 16)}…) as a GUEST. Compare the id with a coordinator's.\nGive your address to a coordinator for a grant; it can reach you over the mesh.\n`);
    }
    await run();
  } else if (cmd === 'apply-grant') {
    const charter = readJson<MeshCharter>(file('charter.json'));
    const saved = readJson<SavedMeshDevice>(file('device.json'));
    const grant = readJson<MeshMembership>(argv[1] ?? die('apply-grant <grant file>'));
    const ev = await evaluateMembership(saved.walletAddress, grant, { charter, meshId: saved.meshId, revokedGrants: new Set() });
    if (ev.state !== 'granted') die(`grant not usable: ${ev.state} (${ev.because})`);
    writePrivate(file('device.json'), { ...saved, credentials: { ...saved.credentials, grant } });
    console.log(`device is now ${grant.role} until ${grant.expiresAt.slice(0, 10)}`);
  } else if (cmd === 'kit-build') {
    const sdkRoot = path.resolve(here, '../..');
    const charter = opt('charter') ? readJson<MeshCharter>(opt('charter')!) : undefined;
    const wn = opt('with-node');
    const withNode = (wn === 'all' ? [...NODE_PLATFORMS] : wn ? wn.split(',') : []) as NodePlatform[];
    for (const p of withNode) if (!(NODE_PLATFORMS as readonly string[]).includes(p)) die(`--with-node: one of all, ${NODE_PLATFORMS.join(', ')}`);
    let signer: { address: string; privateKey: Uint8Array } | undefined;
    if (flag('sign')) { const w = wallet(); if (charter && !charter.authorities.includes(w.address)) die('--sign: this wallet is not an authority of that charter'); signer = { address: w.address, privateKey: w.privateKey }; }
    const out = path.resolve(opt('out') ?? path.join(sdkRoot, 'dist/cappz-mesh-kit'));
    const r = await buildKit({ sdkRoot, out, charter, meshId: charter ? await meshIdOf(charter) : undefined, sdkVersion: readJson<{ version: string }>(path.join(sdkRoot, 'package.json')).version, withNode, signer });
    console.log(`kit: ${out}\nzip: ${r.zip} (${Math.round(fs.statSync(r.zip).size / 1024)} KB)\nfingerprint: ${r.fingerprint}${signer ? `\nsigned by ${signer.address.slice(0, 16)}…` : '\nUNSIGNED: add --sign (as a charter authority) so members can check copies'}`);
  } else if (cmd === 'verify-kit') {
    const dir = path.resolve(argv[1] && !argv[1].startsWith('--') ? argv[1] : here);
    const cf = opt('charter') ?? [path.join(home, 'charter.json'), path.join(dir, 'charter.json')].find((f) => fs.existsSync(f));
    const r = await verifyKit(dir, cf ? readJson<MeshCharter>(cf) : undefined);
    console.log(JSON.stringify(r, null, 2));
    if (r.state !== 'verified-by-authority') process.exit(1);
  } else if (cmd === 'web-build') {
    await webBuild();
  } else if (cmd === 'run') {
    await run();
  } else if (cmd === 'evals') {
    const report = await runMeshEvals({ scale: flag('full') ? 'full' : 'quick', only: opts('only'), onProgress: (o) => console.error(`${o.pass ? 'PASS' : 'FAIL'} ${o.id} (${o.result.cpu.wallMs} ms)`) });
    const md = formatEvalReport(report);
    if (opt('out')) { fs.writeFileSync(opt('out')!, md); fs.writeFileSync(opt('out')!.replace(/\.md$/, '') + '.json', JSON.stringify(report, null, 2)); }
    console.log(md);
    process.exit(report.failed ? 1 : 0);
  } else {
    console.log(HELP);
  }
}

/** The program's own folder: packages/cappz-mesh-node in a checkout, the kit folder in a go-kit. */
const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, 'web');
/** Running from a go-kit: offer the kit itself to devices that do not have it yet. */
const kitDir = fs.existsSync(path.join(here, 'KIT-MANIFEST.json')) ? here : undefined;

const HELP = `cappz-mesh — resilience mesh node (no internet needed)

  quickstart [--charter <f>]          new device: wallet + join as guest + run
  wallet                              create this device's wallet
  charter --name <name>               (authority) found a mesh → charter.json
  grant <address> --role <role>       (authority) coordinator | responder | member → grant file
  join --charter <f> [--grant <f>]    provision this device
  apply-grant <file>                  add a grant to a joined device
  revoke-device [--declaration <f>]   KeyZ revocation of a device key
  revoke-member <grant file>          (authority) revoke a membership
  run [--alias <name>] [--port 41460] [--peer host:port]... [--channel c]... [--no-relay] [--no-discovery] [--web-port 41480] [--no-web] [--kit <dir>]
      [--lora /dev/ttyUSB0 --lora-region eu868|eu868_1pct|us915 [--lora-sf 9] [--lora-cr 5] [--lora-txp 14] [--lora-freq Hz] [--duty 0.01]]
  kit-build [--out d] [--charter f] [--with-node all|linux-x64,...] [--sign]
  verify-kit [<dir>] [--charter f]
  evals [--full] [--out report.md]

Files live in --home (default ~/.cappz-mesh). Guide: MESH_FIELD_GUIDE.md`;

/** Bundle the browser app with esbuild (installed with the SDK's dev dependencies, so this works offline). */
async function webBuild() {
  await bundleMeshWeb(webDir, webDir);
  console.log(`built ${path.join(webDir, 'app.js')} (${Math.round(fs.statSync(path.join(webDir, 'app.js')).size / 1024)} KB)`);
}

async function run() {
  const w = wallet();
  const charter = readJson<MeshCharter>(file('charter.json'));
  const identity = await loadMeshDevice(readJson<SavedMeshDevice>(file('device.json')));
  if (identity.walletAddress !== w.address) die('device.json belongs to another wallet');
  const channels = [...new Set([EVERYONE_CHANNEL, GENERAL_CHANNEL, ...opts('channel')])];
  let prec: Precedence = 'routine';
  let pendingGrant: MeshMembership | null = null;
  const say = (s: string) => { process.stdout.write(`\r${s}\n> `); };
  // Names, nicknames and the block list: this device's own, kept in its home.
  const book = ContactBook.from(fs.existsSync(file('contacts.json')) ? readJson(file('contacts.json')) : null);
  book.onChange = () => fs.writeFileSync(file('contacts.json'), JSON.stringify(book.toJSON(), null, 2));
  let alias = sanitizeAlias(opt('alias')) ?? (fs.existsSync(file('profile.json')) ? readJson<{ alias?: string }>(file('profile.json')).alias : undefined);
  if (opt('alias')) fs.writeFileSync(file('profile.json'), JSON.stringify({ alias }));
  const voices = new VoiceAssembler();
  const voiceDir = file('voice');
  const label = (m: { prec: string; channel?: string; from: string; fromRole: string; hops: number }) =>
    `[${m.prec.toUpperCase()}] ${m.channel === EVERYONE_CHANNEL ? 'to EVERYONE' : m.channel ? '#' + m.channel : 'direct'} from ${book.display(m.from)} (${m.fromRole}, ${m.hops} hops)`;
  const node = await MeshNode.create({
    charter, identity, channels, relay: !flag('no-relay'), storeBytes: Number(opt('store-mb') ?? 64) * 1024 * 1024,
    isBlocked: (wallet) => book.isBlocked(wallet),
    onContact: (c) => book.learnAlias(c.wallet, c.alias),
    onDeliver: (m) => {
      // A grant sent to this wallet over the mesh (/grant on an authority's node): offer to apply it.
      if (!m.channel) {
        try {
          const g = JSON.parse(new TextDecoder().decode(m.body)) as MeshMembership;
          if (g.kind === 'cpz-mesh-membership' && g.member === w.address) { pendingGrant = g; say(`grant received: ${g.role} from ${g.authority.slice(0, 12)}… — type /accept-grant to apply`); return; }
        } catch { /* an ordinary message */ }
      }
      const chat = decodeChat(m.body);
      if (chat.t === 'text') return say(`${label(m)}: ${chat.text}`);
      const clip = voices.push(m.from, chat);
      if (!clip) return;
      fs.mkdirSync(voiceDir, { recursive: true });
      const f = path.join(voiceDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${clip.clip}.${clip.mime.includes('mp4') ? 'm4a' : clip.mime.includes('ogg') ? 'ogg' : 'webm'}`);
      fs.writeFileSync(f, clip.audio);
      say(`${label(m)}: 🎤 voice message ${(clip.ms / 1000).toFixed(0)} s → ${f}`);
    },
    onReceipt: (r) => { if (r.forMe) say(`✓ delivered ${r.of.slice(0, 12)}… to ${book.display(r.recipient)}`); },
  });
  // Bundles carried across a restart.
  const saved = file('store.cpz');
  if (fs.existsSync(saved)) { const { bundles } = await readCarryFile(new Uint8Array(fs.readFileSync(saved))); const v = await node.importBundles(bundles); console.log(`restored ${JSON.stringify(v)}`); }
  await node.publishContact(alias);
  const ip = await startIpMesh(node, { port: Number(opt('port') ?? 41460), peers: opts('peer'), discovery: !flag('no-discovery'), log: (l) => say(`· ${l}`) });
  let web: Awaited<ReturnType<typeof serveMeshWeb>> | null = null;
  if (!flag('no-web')) {
    if (!fs.existsSync(path.join(webDir, 'app.js')) || !fs.existsSync(path.join(webDir, MESH_WEB_WORKER))) await webBuild();
    const kit = opt('kit') ? path.resolve(opt('kit')!) : kitDir;
    web = await serveMeshWeb(node, { home, webDir, kitDir: kit, port: Number(opt('web-port') ?? MESH_WEB_PORT), log: (l) => say(`· ${l}`) });
    console.log(`phones: open ${web.url.join(' or ')} (certificate SHA-256 ${web.sha256.slice(0, 16)}…)`);
    if (kit) console.log(`go-kit for new computers: ${web.url.map((u) => u + 'kit/').join(' or ')}`);
  }
  let radio: RadioMedium | null = null;
  let serial: Awaited<ReturnType<typeof openSerialRadio>> | null = null;
  if (opt('lora')) {
    const regionName = opt('lora-region') ?? die(`--lora needs --lora-region (${Object.keys(LORA_REGIONS).join(' | ')}): the legal frequency and duty cycle differ by country`);
    const region = LORA_REGIONS[regionName as keyof typeof LORA_REGIONS] ?? die(`unknown region ${regionName}`);
    const rnode = { frequency: Number(opt('lora-freq') ?? region.frequency), bandwidth: region.bandwidth, txPower: Number(opt('lora-txp') ?? 14), sf: Number(opt('lora-sf') ?? 9), cr: Number(opt('lora-cr') ?? 5) };
    serial = await openSerialRadio({ device: opt('lora')!, rnode, log: (l) => say(`· ${l}`) });
    radio = new RadioMedium(node, serial, { dutyCycle: Number(opt('duty') ?? region.dutyCycle), log: (l) => say(`· ${l}`) });
    await radio.start();
    const lp = { sf: rnode.sf, bandwidth: rnode.bandwidth, cr: rnode.cr - 4 };
    console.log(`LoRa on ${opt('lora')}: ${(rnode.frequency / 1e6).toFixed(3)} MHz SF${rnode.sf} ${rnode.bandwidth / 1000} kHz, ${(loraBitRate(lp) / 1000).toFixed(2)} kbit/s, a full packet ${Math.round(loraTimeOnAirMs(255, lp))} ms on air, duty cycle ${Number(opt('duty') ?? region.dutyCycle) * 100}% (${region.note})`);
  }
  console.log(`node ${w.address.slice(0, 12)}… ${alias ? `"${alias}" ` : ''}role ${node.role}, mesh ${charter.name}. /help for commands.${alias ? '' : ' Set a name others see: /alias <name>'}`);
  const save = async () => fs.writeFileSync(saved, await writeCarryFile(node.meshId, node.exportBundles()));
  const quit = async () => { await save(); ip.close(); web?.close(); radio?.stop(); serial?.close(); process.exit(0); };
  process.on('SIGINT', () => void quit());
  const persist = setInterval(() => void save(), 60_000); void persist;

  const max = charter.policy.roles[node.role].maxPrecedence;
  const report = (r: { id: string; result: { verdict: string; because: string } }) => {
    if (!r.result.verdict.startsWith('admitted')) return console.log(`not sent: ${r.result.verdict} — ${r.result.because}`);
    console.log(`sent ${r.id.slice(0, 12)}…${PRECEDENCE.indexOf(prec) < PRECEDENCE.indexOf(max) ? ` as ${max.toUpperCase()} (the most a ${node.role} may send)` : ''}`);
  };
  /** @name, nickname or address → one wallet; ambiguity is reported, never guessed. */
  const who = (q: string | undefined): string | null => {
    const found = q ? book.find(q, node.contacts.keys()) : [];
    if (found.length === 1) return found[0];
    console.log(found.length ? `"${q}" matches ${found.length} people — use the address:\n${found.map((x) => `  ${book.display(x)}  ${x}`).join('\n')}` : `nobody called "${q}" yet: /who lists names, or use the address`);
    return null;
  };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  // One command at a time, in order (a piped script's /quit must not overtake its /revoke).
  let queue = Promise.resolve();
  rl.on('line', (line) => { queue = queue.then(() => command(line)); });
  const command = async (line: string) => {
    const [c, a1, ...rest] = line.trim().split(/\s+/);
    try {
      if (c === '/help') console.log([
        'text …                       to #general',
        '/all <text>                  to EVERYONE (important: use /prec priority|immediate|flash)',
        '/dm <who> <text>             direct, sealed (who: @name, nickname or address)',
        '/voice <who|all> <file>      send an audio file as a voice message (≤ 60 s, ~12 kbit/s)',
        '/bc <channel> <text> · /prec ' + PRECEDENCE.join('|'),
        '/alias <name> · /nick <who> <name> · /who · /block <who> · /unblock <who> · /blocked',
        '/peers · /stats · /contacts · /revoke <file> · /export <file> · /import <file>',
        '/grant <address> <role> (authority) · /accept-grant · /quit',
      ].join('\n'));
      else if (c === '/dm') { const to = who(a1); if (to) report(await node.send({ to, body: textMessage(rest.join(' ')), prec })); }
      else if (c === '/all') report(await node.broadcast({ channel: EVERYONE_CHANNEL, body: textMessage([a1, ...rest].join(' ')), prec }));
      else if (c === '/voice') {
        const [target, f] = [a1, rest[0]];
        if (!f || !fs.existsSync(f)) { console.log('/voice <who|all> <audio file (opus/webm, ogg, m4a)>'); return; }
        const audio = new Uint8Array(fs.readFileSync(f));
        const mime = f.endsWith('.m4a') || f.endsWith('.mp4') ? 'audio/mp4' : f.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm';
        const to = target === 'all' ? null : who(target);
        if (target !== 'all' && !to) return;
        const parts = splitVoice(audio, mime, Number(opt('voice-ms') ?? Math.min(MAX_VOICE_MS, Math.round(audio.byteLength / 1.5))));
        for (const p of parts) {
          const r = to ? await node.send({ to, body: encodeChat(p), prec }) : await node.broadcast({ channel: EVERYONE_CHANNEL, body: encodeChat(p), prec });
          if (!r.result.verdict.startsWith('admitted')) { console.log(`voice part ${p.i + 1}/${p.n} not sent: ${r.result.because}`); return; }
        }
        console.log(`voice message sent in ${parts.length} part(s), ${Math.round(audio.byteLength / 1024)} KB`);
      }
      else if (c === '/alias') { alias = sanitizeAlias([a1, ...rest].join(' ')); fs.writeFileSync(file('profile.json'), JSON.stringify({ alias })); await node.publishContact(alias); console.log(alias ? `you are "${alias}" — names are not unique: others see it with your address` : 'alias cleared'); }
      else if (c === '/nick') { const t = who(a1); if (t) { book.setNickname(t, rest.join(' ') || null); console.log(`→ ${book.display(t)}`); } }
      else if (c === '/who') { const all = new Set([...book.known, ...node.contacts.keys()]); all.delete(w.address); console.log([...all].map((x) => `${book.display(x)}${book.isBlocked(x) ? '  [blocked]' : ''}\n    ${x}`).join('\n') || 'nobody yet'); }
      else if (c === '/block') { const t = who(a1); if (t) { book.block(t); console.log(`blocked ${book.display(t)}: their messages (direct and to everyone) are hidden and not carried; dropped ${node.dropFrom(t)} carried`); } }
      else if (c === '/unblock') { const t = who(a1); if (t) { book.unblock(t); console.log(`unblocked ${book.display(t)}`); } }
      else if (c === '/blocked') console.log(book.blocked.map((x) => book.display(x)).join('\n') || 'nobody blocked');
      else if (c === '/bc') report(await node.broadcast({ channel: a1, body: textMessage(rest.join(' ')), prec }));
      else if (c === '/prec') { if ((PRECEDENCE as readonly string[]).includes(a1)) prec = a1 as Precedence; console.log(`precedence ${prec}`); }
      else if (c === '/peers') console.log(ip.links().map((l) => l.remote).join('\n') || 'no links');
      else if (c === '/stats') console.log(JSON.stringify({ ...node.stats, stored: node.store.size, storeBytes: node.store.bytes, gate: node.gate.counts, ...(radio ? { radio: radio.stats } : {}) }, null, 2));
      else if (c === '/contacts') console.log([...node.contacts.keys()].join('\n') || 'none yet');
      else if (c === '/revoke') { const r = readJson<KeyRevocation | MeshMembershipRevocation>(a1); const res = 'kind' in r && r.kind === 'cpz-mesh-membership-revocation' ? await node.publishMembershipRevocation(r) : await node.publishKeyRevocation(r as KeyRevocation); console.log(`${res.result.verdict} — ${res.result.because}`); }
      else if (c === '/export') { fs.writeFileSync(a1, await writeCarryFile(node.meshId, node.exportBundles())); console.log(`wrote ${node.store.size} bundles to ${a1}`); }
      else if (c === '/import') { const { bundles } = await readCarryFile(new Uint8Array(fs.readFileSync(a1))); console.log(JSON.stringify(await node.importBundles(bundles))); }
      else if (c === '/grant') {
        // An authority grants a role to a device it can reach over the mesh (sealed to the device's published key).
        if (!charter.authorities.includes(w.address)) { console.log('only a charter authority can grant'); return; }
        const role = (rest[0] ?? 'member') as MeshMembership['role'];
        if (!['coordinator', 'responder', 'member'].includes(role)) { console.log('role: coordinator | responder | member'); return; }
        const g = await grantMembership(w.privateKey, { meshId: node.meshId, authority: w.address, member: a1, role });
        fs.writeFileSync(file(`grant-${a1.slice(0, 12)}.json`), JSON.stringify(g, null, 2));
        if (!node.contacts.has(a1)) { console.log(`no contact for ${a1.slice(0, 12)}… yet: grant saved to ${file(`grant-${a1.slice(0, 12)}.json`)}; carry it over, or retry when their contact arrives`); return; }
        report(await node.send({ to: a1, body: utf8(JSON.stringify(g)), prec: 'priority' }));
      } else if (c === '/accept-grant') {
        if (!pendingGrant) { console.log('no grant received'); return; }
        const ev = await evaluateMembership(w.address, pendingGrant, { charter, meshId: node.meshId, revokedGrants: node.gate.revokedGrants });
        if (ev.state !== 'granted') { console.log(`grant not usable: ${ev.because}`); return; }
        node.identity.credentials = { ...node.identity.credentials, grant: pendingGrant };
        const saved = readJson<SavedMeshDevice>(file('device.json'));
        writePrivate(file('device.json'), { ...saved, credentials: node.identity.credentials });
        console.log(`now ${pendingGrant.role}: new messages carry the grant; links re-introduce it on reconnect`);
        pendingGrant = null;
      }
      else if (c === '/quit') await quit();
      else if (line.trim()) report(await node.broadcast({ channel: GENERAL_CHANNEL, body: textMessage(line.trim()), prec }));
    } catch (e) { console.log(`error: ${(e as Error).message}`); }
    rl.prompt();
  };
}

void main();
