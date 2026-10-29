/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-web-app
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The mesh in a phone's browser (iPhone, iPad, Android, any laptop): a full
 * MeshNode with its own wallet, device key and encryption key, kept in this
 * browser's storage. It links to the node that served it (WebSocket) and to
 * other phones directly (WebRTC pairing codes). Bundled by
 * `main.ts web-build` into web/app.js; no network beyond the local one.
 *
 * Storage: localStorage of this origin (https://<node ip>:41480). A different
 * node is a different origin, so a phone keeps using the node it was set up
 * with, or restores its backup on another (Backup / Restore below).
 */

import { generateRecoveryPhrase, keyPairFromPhrase } from '../../../src/lib/auth/wallet/session.ts';
import { utf8 } from '../../../src/lib/identity/canonical.ts';
import { meshIdOf, verifyCharter, PRECEDENCE, type MeshCharter, type MeshMembership, type Precedence } from '../../../src/lib/mesh/meshIdentity.ts';
import { MeshNode, provisionMeshDevice, saveMeshDevice, loadMeshDevice, type SavedMeshDevice, type MeshLink, type Delivery } from '../../../src/lib/mesh/meshNode.ts';
import { writeCarryFile, readCarryFile } from '../../../src/lib/mesh/meshCarry.ts';
import { offerPairing, answerPairing, type PendingPair } from '../../../src/lib/mesh/meshWebRtc.ts';
import { attachNativeBridge, detectNativeHost } from '../../../src/lib/mesh/meshNative.ts';
import { ContactBook, VoiceAssembler, decodeChat, encodeChat, textMessage, splitVoice, sanitizeAlias, EVERYONE_CHANNEL, GENERAL_CHANNEL, type ContactBookData } from '../../../src/lib/mesh/meshChat.ts';
import { recordVoice, type Recording } from '../../../src/lib/mesh/meshVoice.ts';

const KEY = 'cappz-mesh-v1';
interface Saved { phrase?: string; charter?: MeshCharter; grant?: MeshMembership; device?: SavedMeshDevice; store?: string; log?: string[]; alias?: string; book?: ContactBookData }
const load = (): Saved => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved; } catch { return {}; } };
const save = (s: Saved) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { note(`could not save: ${(e as Error).message}`); } };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function note(s: string) { const el = $('notes'); el.textContent = `${new Date().toLocaleTimeString()} ${s}\n${el.textContent}`.slice(0, 4000); }
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let node: MeshNode | null = null;
let pending: PendingPair | null = null;
let book = new ContactBook();
const voices = new VoiceAssembler();
let recording: Recording | null = null;

function show(section: 'setup' | 'mesh') {
  $('setup').hidden = section !== 'setup';
  $('mesh').hidden = section !== 'mesh';
}

function renderSetup() {
  const s = load();
  const w = s.phrase ? keyPairFromPhrase(s.phrase) : null;
  $('wallet-state').innerHTML = w ? `Wallet <code class="addr">${esc(w.address)}</code>` : 'No wallet on this device yet.';
  $('make-wallet').hidden = !!w;
  $('share-address').hidden = !w;
  $('charter-state').textContent = s.charter ? `Mesh “${s.charter.name}”` : 'No charter yet.';
  $('grant-state').textContent = s.grant ? `${s.grant.role} until ${s.grant.expiresAt.slice(0, 10)}` : 'No grant: you will join as a guest (ROUTINE only, no broadcasts).';
  $('provision').toggleAttribute('disabled', !(w && s.charter));
}

async function provision() {
  const s = load();
  const w = keyPairFromPhrase(s.phrase!);
  if (s.grant && s.grant.member !== w.address) return note('that grant names another wallet');
  const id = await provisionMeshDevice({ walletPrivateKey: w.privateKey, walletAddress: w.address, grant: s.grant });
  s.device = await saveMeshDevice(await meshIdOf(s.charter!), id);
  save(s);
  await start();
}

function addMessage(html: string, cls = '', keep = true) {
  const li = document.createElement('li');
  li.className = cls; li.innerHTML = html;
  $('feed').prepend(li);
  if (!keep) return;
  const s = load(); s.log = [`<li class="${cls}">${html}</li>`, ...(s.log ?? [])].slice(0, 200); save(s);
}

/** Header of a received message: who (name + address start), where, how urgent, and a block button. */
function heading(d: Delivery): string {
  const where = d.channel === EVERYONE_CHANNEL ? 'to <b>everyone</b>' : d.channel ? '#' + esc(d.channel) : 'direct';
  return `<b class="p-${d.prec}">${d.prec.toUpperCase()}</b> ${where} · <span class="who">${esc(book.display(d.from))}</span> <small>${d.fromRole}, ${d.hops} hops</small> <button class="link" data-block="${esc(d.from)}">block</button>`;
}

function onDeliver(d: Delivery) {
  const chat = decodeChat(d.body);
  if (chat.t === 'text') return addMessage(`${heading(d)}<br>${esc(chat.text)}`, d.prec);
  const clip = voices.push(d.from, chat);
  if (!clip) return;
  const url = URL.createObjectURL(new Blob([clip.audio.slice()], { type: clip.mime }));
  addMessage(`${heading(d)}<br>🎤 <audio controls preload="metadata" src="${url}"></audio> <small>${Math.round(clip.ms / 1000)} s</small>`, d.prec, false);
  const s = load(); s.log = [`<li class="${d.prec}">${heading(d)}<br>🎤 voice message (${Math.round(clip.ms / 1000)} s — not kept after reload)</li>`, ...(s.log ?? [])].slice(0, 200); save(s);
}

function renderPeople() {
  if (!node) return;
  const all = new Set([...book.known, ...node.contacts.keys(), ...book.blocked]);
  all.delete(node.identity.walletAddress);
  ($('to') as HTMLSelectElement).innerHTML = [`<option value="#${EVERYONE_CHANNEL}">Everyone (important)</option>`, `<option value="#${GENERAL_CHANNEL}">#general</option>`,
    ...[...all].filter((w) => !book.isBlocked(w) && node!.contacts.has(w)).map((w) => `<option value="${esc(w)}">${esc(book.display(w))}</option>`)].join('');
  $('people').innerHTML = [...all].map((w) => `<li><span class="who">${esc(book.display(w))}</span>${book.isBlocked(w) ? ' <b>blocked</b>' : ''}<br><code class="addr">${esc(w)}</code><br>
    <button class="link" data-nick="${esc(w)}">nickname</button> ${book.isBlocked(w) ? `<button class="link" data-unblock="${esc(w)}">unblock</button>` : `<button class="link" data-block="${esc(w)}">block</button>`}</li>`).join('') || '<li class="muted">Nobody yet: names arrive as people come into range.</li>';
}

async function sendVoice(r: { audio: Uint8Array; mime: string; ms: number }) {
  if (!node) return;
  const to = ($('to') as HTMLSelectElement).value;
  const prec = ($('prec') as HTMLSelectElement).value as Precedence;
  for (const p of splitVoice(r.audio, r.mime, r.ms)) {
    const body = encodeChat(p);
    const res = to.startsWith('#') ? await node.broadcast({ channel: to.slice(1), body, prec }) : await node.send({ to, body, prec });
    if (!res.result.verdict.startsWith('admitted')) return note(`voice not sent: ${res.result.because}`);
  }
  addMessage(`<i>you → ${to.startsWith('#') ? esc(to === '#' + EVERYONE_CHANNEL ? 'everyone' : to) : esc(book.display(to))}</i> (${prec})<br>🎤 voice message, ${Math.round(r.ms / 1000)} s, ${Math.round(r.audio.byteLength / 1024)} KB`, 'mine');
}

async function start() {
  const s = load();
  if (!s.device || !s.charter) return show('setup');
  const identity = await loadMeshDevice(s.device);
  book = ContactBook.from(s.book);
  book.onChange = () => { const x = load(); x.book = book.toJSON(); save(x); renderPeople(); };
  node = await MeshNode.create({
    charter: s.charter, identity, channels: [EVERYONE_CHANNEL, GENERAL_CHANNEL],
    isBlocked: (w) => book.isBlocked(w),
    onContact: (c) => { book.learnAlias(c.wallet, c.alias); renderPeople(); },
    onDeliver,
    onReceipt: (r) => { if (r.forMe) addMessage(`✓ delivered to ${esc(book.display(r.recipient))}`, 'receipt'); },
  });
  if (s.store) { try { await node.importBundles((await readCarryFile(unb64(s.store))).bundles); } catch { /* old store */ } }
  await node.publishContact(s.alias);
  ($('alias') as HTMLInputElement).value = s.alias ?? '';
  $('feed').innerHTML = (s.log ?? []).join('');
  $('me').innerHTML = `${s.alias ? `<b>${esc(s.alias)}</b> · ` : ''}<code class="addr">${esc(identity.walletAddress)}</code> · ${node.role} · mesh “${esc(s.charter.name)}”`;
  renderPeople();
  const max = s.charter.policy.roles[node.role].maxPrecedence;
  ($('prec') as HTMLSelectElement).innerHTML = PRECEDENCE.slice(PRECEDENCE.indexOf(max)).map((p) => `<option ${p === 'routine' ? 'selected' : ''}>${p}</option>`).join('');
  if (!s.alias) note('set a name others will see: Me → Name');
  show('mesh');
  // In the native app (iOS / Android shell), its radios bring peers; served by a node over HTTPS, link back to that node.
  const native = detectNativeHost();
  if (native) attachNativeBridge(node, native, { log: (l) => { note(l); renderStatus(); } });
  if (location.protocol === 'https:') connectServer();
  setInterval(() => { node?.tick(); void persist(); renderStatus(); }, 15_000);
  renderStatus();
}

async function persist() {
  if (!node) return;
  const s = load(); s.store = b64(await writeCarryFile(node.meshId, node.exportBundles(400))); save(s);
}

function renderStatus() {
  if (!node) return;
  $('status').textContent = `${node.peerCount} link(s) · carrying ${node.store.size} bundle(s) · ${node.contacts.size} people reachable`;
  renderPeople();
}

function connectServer() {
  if (!node) return;
  const n = node;
  const ws = new WebSocket(`wss://${location.host}/mesh`);
  ws.binaryType = 'arraybuffer';
  const id = `wss:${location.host}#${Date.now()}`;
  ws.onopen = () => {
    const link: MeshLink = { id, carrier: 'wss', send: (b) => { if (ws.readyState === 1) ws.send(b.slice()); }, close: () => ws.close() };
    void n.linkUp(link); note(`linked to ${location.host}`); renderStatus();
  };
  ws.onmessage = (e) => void n.receive(id, new Uint8Array(e.data as ArrayBuffer));
  ws.onclose = () => { n.linkDown(id); renderStatus(); setTimeout(connectServer, 5000); };
}

const onBytes = (id: string, b: Uint8Array) => void node?.receive(id, b);
const onDown = (id: string) => { node?.linkDown(id); renderStatus(); note('phone link closed'); };
async function pairedLink(p: PendingPair) {
  try { const link = await p.link; await node!.linkUp(link); note('phone linked directly'); renderStatus(); } catch (e) { note((e as Error).message); }
}

async function share(text: string) {
  try { if (navigator.share) { await navigator.share({ text }); return; } } catch { /* cancelled */ }
  try { await navigator.clipboard.writeText(text); note('copied'); } catch { prompt('Copy this:', text); }
}

function bind() {
  $('make-wallet').onclick = () => {
    const phrase = generateRecoveryPhrase();
    const s = load(); s.phrase = phrase; save(s);
    alert(`Write these 24 words on paper and keep them safe. They are the only way to revoke this phone if it is lost:\n\n${phrase}`);
    renderSetup();
  };
  $('share-address').onclick = () => { const s = load(); void share(keyPairFromPhrase(s.phrase!).address); };
  $('charter-from-node').onclick = async () => {
    const c = await (await fetch('/charter.json')).json() as MeshCharter;
    if ((await verifyCharter(c)) !== 'valid') return note('charter does not verify');
    if (!confirm(`Join mesh “${c.name}”, id ${(await meshIdOf(c)).slice(0, 16)}…?\nCompare the id with your coordinator’s.`)) return;
    const s = load(); s.charter = c; save(s); renderSetup();
  };
  const readFile = (input: HTMLInputElement) => new Promise<string>((resolve) => { const f = input.files?.[0]; if (!f) return resolve(''); f.text().then(resolve); });
  ($('charter-file') as HTMLInputElement).onchange = async (e) => {
    const c = JSON.parse(await readFile(e.target as HTMLInputElement)) as MeshCharter;
    if ((await verifyCharter(c)) !== 'valid') return note('charter does not verify');
    const s = load(); s.charter = c; save(s); renderSetup();
  };
  ($('grant-file') as HTMLInputElement).onchange = async (e) => { const s = load(); s.grant = JSON.parse(await readFile(e.target as HTMLInputElement)) as MeshMembership; save(s); renderSetup(); };
  $('grant-paste').onclick = () => { const t = prompt('Paste the grant JSON'); if (!t) return; const s = load(); s.grant = JSON.parse(t) as MeshMembership; save(s); renderSetup(); };
  $('provision').onclick = () => void provision().catch((e) => note((e as Error).message));

  ($('compose') as HTMLFormElement).onsubmit = async (e) => {
    e.preventDefault();
    if (!node) return;
    const to = ($('to') as HTMLSelectElement).value;
    const text = ($('text') as HTMLInputElement).value.trim();
    const prec = ($('prec') as HTMLSelectElement).value as Precedence;
    if (!text) return;
    const body = textMessage(text);
    const r = to.startsWith('#') ? await node.broadcast({ channel: to.slice(1), body, prec }) : await node.send({ to, body, prec });
    if (r.result.verdict.startsWith('admitted')) { addMessage(`<i>you → ${to === '#' + EVERYONE_CHANNEL ? '<b>everyone</b>' : to.startsWith('#') ? esc(to) : esc(book.display(to))}</i> (${prec})<br>${esc(text)}`, 'mine'); ($('text') as HTMLInputElement).value = ''; }
    else note(`not sent: ${r.result.because}`);
    renderStatus();
  };
  $('mic').onclick = async () => {
    const btn = $('mic');
    if (recording) { const r = recording; recording = null; btn.textContent = '🎤'; btn.classList.remove('rec'); try { await sendVoice(await r.stop()); } catch (err) { note((err as Error).message); } return; }
    try { recording = await recordVoice({ maxMs: 30_000 }); btn.textContent = '■ send'; btn.classList.add('rec'); note('recording… tap again to send (30 s max)'); }
    catch (err) { note(`microphone: ${(err as Error).message}`); }
  };
  // Block / unblock / nickname from any message or the People list.
  document.body.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const blockW = t.dataset.block, unblockW = t.dataset.unblock, nickW = t.dataset.nick;
    if (blockW && node && confirm(`Block ${book.display(blockW)}? You will not see or carry their messages, including messages to everyone.`)) { book.block(blockW); note(`blocked; dropped ${node.dropFrom(blockW)} carried message(s)`); }
    if (unblockW) { book.unblock(unblockW); note(`unblocked ${book.display(unblockW)}`); }
    if (nickW) { const n = prompt(`Your nickname for ${book.display(nickW)} (empty to clear)`, book.nicknameOf(nickW) ?? ''); if (n !== null) book.setNickname(nickW, n || null); }
  });
  $('alias-save').onclick = async () => {
    const s = load(); s.alias = sanitizeAlias(($('alias') as HTMLInputElement).value); save(s);
    if (node) await node.publishContact(s.alias);
    note(s.alias ? `you are “${s.alias}” — others see it with your address` : 'name cleared');
  };
  $('add-person').onclick = () => {
    const a = prompt('Their wallet address (66 characters)')?.trim().toLowerCase();
    if (!a || !/^[0-9a-f]{66}$/.test(a)) return;
    const n = prompt('A nickname for them (optional)'); if (n) book.setNickname(a, n); else renderPeople();
    if (!node?.contacts.has(a)) note('you can message them once their contact reaches you');
  };
  $('pair-offer').onclick = async () => {
    pending?.cancel();
    pending = await offerPairing(onBytes, onDown);
    ($('pair-code') as HTMLTextAreaElement).value = pending.code;
    note('offer made: send it to the other phone, then paste its answer and press Finish');
    void pairedLink(pending);
  };
  $('pair-share').onclick = () => void share(($('pair-code') as HTMLTextAreaElement).value);
  $('pair-answer').onclick = async () => {
    const code = ($('pair-input') as HTMLTextAreaElement).value;
    try {
      if (pending?.complete && code.includes('CPZM1A')) { await pending.complete(code); note('answer applied, linking…'); return; }
      pending?.cancel();
      pending = await answerPairing(code, onBytes, onDown);
      ($('pair-code') as HTMLTextAreaElement).value = pending.code;
      note('answer made: send it back to the phone that made the offer');
      void pairedLink(pending);
    } catch (e) { note((e as Error).message); }
  };
  $('backup').onclick = () => {
    const blob = new Blob([JSON.stringify(load())], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'cappz-mesh-backup.json'; a.click();
  };
  ($('restore') as HTMLInputElement).onchange = async (e) => { const t = await readFile(e.target as HTMLInputElement); if (t && confirm('Replace this browser’s mesh identity with the backup?')) { localStorage.setItem(KEY, t); location.reload(); } };
  $('copy-me').onclick = () => { if (node) void share(node.identity.walletAddress); };
  window.addEventListener('pagehide', () => void persist());
}

bind();
renderSetup();
void start().catch((e) => { note((e as Error).message); show('setup'); });
