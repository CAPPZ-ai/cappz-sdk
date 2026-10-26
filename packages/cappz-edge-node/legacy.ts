/**
 * COPE node crystallized.
 * Node ID: v15-09-00-edge-node-legacy
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * --legacy <port> (default 41447): the DMZ quarantine zone and legacy front
 * end (src/lib/sync/transports/legacyGateway.ts) — HTTP drops in, receipts,
 * released listing and fetch for internal clients, signed operator decisions —
 * plus the CAPPZ FTP client pulling partner FTPS/SFTP directories
 * (src/lib/sync/transports/legacyPull.ts, system curl).
 *
 * Held bytes: <CAPPZ_NODE_DATA>/dmz/held/<sha256> (never replicated).
 * Released: moved into the body store (objects/), so peers replicate them.
 * Records: signed edge TXs in <CAPPZ_NODE_DATA>/edge-txs.jsonl (as jobs).
 * inbox/ (trusted operator drop, v15-04-00) is unchanged.
 *
 * Env: CAPPZ_DMZ_OPERATORS (wallets whose signed decisions count),
 *      CAPPZ_DMZ_REQUIRE (checks required for automatic release; default
 *      hash,size-limit,type-sniff), CAPPZ_DMZ_MAX_BYTES, CAPPZ_DMZ_ALLOWED_TYPES,
 *      CAPPZ_DMZ_SCAN_CMD (e.g. "clamdscan --no-summary -": exit 0 clean,
 *      1 infected; bytes on stdin), CAPPZ_LEGACY_HOST (default 127.0.0.1 —
 *      put nginx in front for TLS), CAPPZ_LEGACY_SIGNED_FETCH=1.
 * Pull sources: <CAPPZ_NODE_DATA>/legacy-pull.json, [{ id, url, userEnv,
 * passEnv, suffix, intervalSec }]; credentials stay in the environment.
 *
 * v15-10-00 --ftps <port> (default 41449): implicit FTPS server face for
 * senders that can only push by FTP (src/lib/sync/transports/ftpServer.ts).
 * TLS from the node's TLS handle; accounts in <CAPPZ_NODE_DATA>/ftp-accounts.json
 * ([{ user, passEnv, sender }], passwords in the environment);
 * CAPPZ_FTP_PASV_HOST names the address passive replies give (default: the
 * control connection's local address). Uploads go into the same quarantine.
 */

import { createLegacyGateway, type QuarantineStore } from '../../src/lib/sync/transports/legacyGateway.ts';
import { intakeQuarantined, DEFAULT_QUARANTINE_POLICY, type CheckName, type QuarantinePolicy } from '../../src/lib/sync/quarantine.ts';
import { checkSource, curlPlan, parseListing, planPull, recordableRemote, seenKey, type LegacyPullSource } from '../../src/lib/sync/transports/legacyPull.ts';
import { signEdgeTx, type UnsignedEdgeTx } from '../../src/lib/functions/edgeJobs.ts';
import { transportTypeAddress } from '../../src/lib/wallets/paths.ts';
import type { NodeBodyStore } from './objects.ts';
import type { VerifyGateway } from '../../src/lib/identity/edgeVerify.ts';
import { createFtpSession, type FtpAccount, type FtpIo } from '../../src/lib/sync/transports/ftpServer.ts';
import type { TlsHandle } from './tlsIdentity.ts';

type NodeKey = { privateKey: CryptoKey; publicKeyHex: string };

function policyFromEnv(): QuarantinePolicy {
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const required = list(Deno.env.get('CAPPZ_DMZ_REQUIRE')) as CheckName[];
  return {
    ...DEFAULT_QUARANTINE_POLICY,
    ...(required.length ? { required } : {}),
    maxBytes: Number(Deno.env.get('CAPPZ_DMZ_MAX_BYTES') ?? '') || DEFAULT_QUARANTINE_POLICY.maxBytes,
    allowedTypes: list(Deno.env.get('CAPPZ_DMZ_ALLOWED_TYPES')),
    operators: list(Deno.env.get('CAPPZ_DMZ_OPERATORS')),
  };
}

function fileQuarantineStore(dataDir: string, bodies: NodeBodyStore, key: NodeKey): QuarantineStore {
  const heldDir = `${dataDir}/dmz/held`;
  const logPath = `${dataDir}/edge-txs.jsonl`;
  const ok = (s: string) => /^[0-9a-f]{64}$/.test(s);
  return {
    async hold(sha, bytes) { await Deno.mkdir(heldDir, { recursive: true }); const tmp = `${heldDir}/.${sha}.tmp`; await Deno.writeFile(tmp, bytes); await Deno.rename(tmp, `${heldDir}/${sha}`); },
    async held(sha) { if (!ok(sha)) return null; try { return await Deno.readFile(`${heldDir}/${sha}`); } catch { return null; } },
    // Large files go in as chunks + manifest (replicable); they are still fetched by whole-file hash.
    async release(sha) { const b = await this.held(sha); if (!b) return; await bodies.putWhole(b); await Deno.remove(`${heldDir}/${sha}`).catch(() => {}); },
    async discard(sha) { if (ok(sha)) await Deno.remove(`${heldDir}/${sha}`).catch(() => {}); },
    released: (sha) => bodies.getWhole(sha),
    async append(txs) { for (const t of txs) await Deno.writeTextFile(logPath, JSON.stringify(await signEdgeTx(t, key)) + '\n', { append: true }); },
    async log() {
      let text = '';
      try { text = await Deno.readTextFile(logPath); } catch { return []; }
      return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as UnsignedEdgeTx; } catch { return null; } }).filter((t): t is UnsignedEdgeTx => Boolean(t));
    },
  };
}

async function scanWith(cmd: string | undefined) {
  if (!cmd) return undefined;
  const [bin, ...args] = cmd.split(/\s+/);
  return async (bytes: Uint8Array) => {
    const p = new Deno.Command(bin, { args, stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn();
    const w = p.stdin.getWriter(); await w.write(bytes); await w.close();
    const out = await p.output();
    const text = new TextDecoder().decode(out.stdout).trim().slice(0, 200);
    if (out.code === 0) return { result: 'pass' as const, reason: `${bin}: clean` };
    if (out.code === 1) return { result: 'fail' as const, reason: `${bin}: ${text || 'infected'}` };
    return { result: 'not-evaluated' as const, reason: `${bin} exited ${out.code}` };
  };
}

async function curl(plan: { args: string[]; stdin: string }): Promise<{ ok: boolean; bytes: Uint8Array; error: string }> {
  const p = new Deno.Command('curl', { args: plan.args, stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn();
  const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(plan.stdin)); await w.close();
  const out = await p.output();
  return { ok: out.code === 0, bytes: out.stdout, error: new TextDecoder().decode(out.stderr).trim().slice(0, 300) };
}

async function runPulls(dataDir: string, nodeAddress: string, store: QuarantineStore, policy: QuarantinePolicy, scan: Awaited<ReturnType<typeof scanWith>>): Promise<void> {
  let sources: LegacyPullSource[] = [];
  try { sources = JSON.parse(await Deno.readTextFile(`${dataDir}/legacy-pull.json`)); } catch { return; }
  const seenPath = `${dataDir}/legacy-pull-seen.json`;
  const seen = new Set<string>(await Deno.readTextFile(seenPath).then((t) => JSON.parse(t) as string[]).catch(() => []));
  const env = Deno.env.toObject();
  for (const s of sources) {
    const c = checkSource(s);
    if (c.ok === false) { console.warn(`[edge-node] pull ${s.id} off: ${(c as { reason: string }).reason}`); continue; }
    const tick = async () => {
      const list = await curl(curlPlan(s, 'list', env));
      if (!list.ok) { console.warn(`[edge-node] pull ${s.id} list failed: ${list.error}`); return; }
      for (const name of planPull(s, parseListing(new TextDecoder().decode(list.bytes)), seen)) {
        const got = await curl(curlPlan({ ...s, maxBytes: s.maxBytes ?? policy.maxBytes }, 'get', env, name));
        if (!got.ok) { console.warn(`[edge-node] pull ${s.id}/${name} failed: ${got.error}`); continue; }
        const external = scan ? { 'malware-scan': await scan(got.bytes).catch((e) => ({ result: 'not-evaluated' as const, reason: String(e) })) } : undefined;
        const r = await intakeQuarantined({ nodeAddress, bytes: got.bytes, name, policy, external, source: { kind: (c as { scheme: string }).scheme === 'sftp' ? 'sftp' : 'ftps', transportType: transportTypeAddress((c as { scheme: string }).scheme === 'sftp' ? 'sftp' : 'ftps'), remote: recordableRemote(s.url) } });
        await store.hold(r.sha256, got.bytes); await store.append(r.txs);
        if (r.decision === 'released') await store.release(r.sha256);
        if (r.decision === 'rejected') await store.discard(r.sha256);
        seen.add(seenKey(s, name));
        await Deno.writeTextFile(seenPath, JSON.stringify([...seen]));
        console.log(`[edge-node] pulled ${s.id}/${name} → ${r.decision} (${r.because})`);
      }
    };
    await tick().catch((e) => console.warn(`[edge-node] pull ${s.id}: ${e?.message ?? e}`));
    setInterval(() => void tick().catch((e) => console.warn(`[edge-node] pull ${s.id}: ${e?.message ?? e}`)), (s.intervalSec ?? 300) * 1000);
  }
}

async function serveFtps(port: number, dataDir: string, tls: TlsHandle, gw: ReturnType<typeof createLegacyGateway>, maxBytes: number): Promise<void> {
  let accounts: FtpAccount[] = [];
  try { accounts = JSON.parse(await Deno.readTextFile(`${dataDir}/ftp-accounts.json`)); } catch { /* none */ }
  if (!accounts.length) { console.log('[edge-node] ftps off: no accounts in ftp-accounts.json'); return; }
  const hostname = Deno.env.get('CAPPZ_FTP_HOST') ?? '0.0.0.0';
  console.log(`[edge-node] ftps ${hostname}:${port} (implicit TLS)  ${accounts.length} account(s); uploads go to quarantine`);
  const enc = new TextEncoder();
  // Re-open the control listener on TLS rotation (open sessions keep their connection).
  let listener = Deno.listenTls({ port, hostname, cert: tls.current().cert, key: tls.current().key });
  tls.onRotate(async () => {
    try { listener.close(); } catch { /* closed */ }
    // The port frees shortly after close (seen: AddrInUse on an immediate re-bind); retry for up to 5 s.
    for (let i = 0; ; i++) {
      try { listener = Deno.listenTls({ port, hostname, cert: tls.current().cert, key: tls.current().key }); return; }
      catch (err) { if (i >= 50) throw new Error(`ftps re-bind after TLS rotation failed: ${err instanceof Error ? err.message : err}`); await new Promise((r) => setTimeout(r, 100)); }
    }
  }, 'ftps');
  // Concurrent sessions are capped (CAPPZ_FTP_MAX_SESSIONS, default 64): each holds buffers and a passive port.
  const maxSessions = Number(Deno.env.get('CAPPZ_FTP_MAX_SESSIONS') ?? '') || 64; let open = 0;
  for (;;) {
    let conn: Deno.TlsConn;
    try { conn = await listener.accept(); } catch { await new Promise((r) => setTimeout(r, 50)); continue; }
    if (open >= maxSessions) { conn.write(enc.encode('421 Too many connections; try again later\r\n')).finally(() => { try { conn.close(); } catch { /* closed */ } }); continue; }
    open++;
    (async () => {
      const send = (lines: string[]) => conn.write(enc.encode(lines.map((l) => `${l}\r\n`).join('')));
      const env = Deno.env.toObject();
      const session = createFtpSession({ accounts, env, maxBytes, store: gw.intakeFile, released: async () => (await gw.entries()).filter((e) => e.state === 'released').map((e) => ({ name: e.name, size: e.size, sha256: e.sha256 })) });
      let data: Deno.TlsListener | null = null;
      const local = conn.localAddr as Deno.NetAddr; const remote = conn.remoteAddr as Deno.NetAddr;
      const acceptData = async () => {
        if (!data) throw new Error('no passive listener');
        const l = data; data = null;
        const t = setTimeout(() => { try { l.close(); } catch { /* closed */ } }, 30_000);
        try { return await l.accept(); } finally { clearTimeout(t); try { l.close(); } catch { /* closed */ } }
      };
      const io: FtpIo = {
        remote: `${remote.hostname}:${remote.port}`,
        async openPassive() {
          try { data?.close(); } catch { /* closed */ }
          data = Deno.listenTls({ port: 0, hostname, cert: tls.current().cert, key: tls.current().key });
          return { host: Deno.env.get('CAPPZ_FTP_PASV_HOST') ?? local.hostname, port: (data.addr as Deno.NetAddr).port };
        },
        async readData(max) {
          const c = await acceptData();
          const parts: Uint8Array[] = []; let n = 0; const buf = new Uint8Array(64 * 1024);
          try {
            for (;;) {
              let r: number | null;
              // Clients (curl among them) often end the data connection without TLS close_notify: that is the end of the
              // upload, as most FTPS servers treat it. The receipt's sha256 lets the sender confirm nothing was cut.
              try { r = await c.read(buf); } catch (err) { if (err instanceof Deno.errors.UnexpectedEof || /close_notify/.test(String(err))) r = null; else throw err; }
              if (r === null) break;
              n += r; if (n > max) throw new Error(`file exceeds ${max} bytes`); parts.push(buf.slice(0, r));
            }
          } finally { try { c.close(); } catch { /* closed */ } }
          const out = new Uint8Array(n); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
          return out;
        },
        preliminary: (line) => send([line]).then(() => {}),
        async writeData(bytes) { const c = await acceptData(); try { await c.write(bytes); } finally { try { c.close(); } catch { /* closed */ } } },
      };
      await send([session.greeting]);
      const dec = new TextDecoder(); let pending = ''; const buf = new Uint8Array(4096);
      for (;;) {
        const r = await conn.read(buf);
        if (r === null) break;
        pending += dec.decode(buf.subarray(0, r), { stream: true });
        if (pending.length > 8192) { await send(['500 Line too long']); break; }
        let i: number; let closed = false;
        while ((i = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, i).replace(/\r$/, ''); pending = pending.slice(i + 1);
          const res = await session.handle(line, io);
          await send(res.replies);
          if (res.close) { closed = true; break; }
        }
        if (closed) break;
      }
    })().catch((err) => console.warn('[edge-node] ftps session ended:', err?.message ?? err)).finally(() => { open--; try { conn.close(); } catch { /* closed */ } });
  }
}

export async function serveLegacy(o: { port: number; dataDir: string; nodeAddress: string; key: NodeKey | null; bodies: NodeBodyStore; verify: VerifyGateway; directory?: () => Promise<unknown>; ftpsPort?: number; tls?: TlsHandle | null }): Promise<void> {
  if (!o.key) { console.log('[edge-node] legacy front end off: needs CAPPZ_NODE_KEY / CAPPZ_NODE_PUB (every quarantine record is signed)'); return; }
  const policy = policyFromEnv();
  const store = fileQuarantineStore(o.dataDir, o.bodies, o.key);
  const scan = await scanWith(Deno.env.get('CAPPZ_DMZ_SCAN_CMD'));
  const gw = createLegacyGateway({ nodeAddress: o.nodeAddress, store, policy, verify: o.verify, scan, requireSignedFetch: Deno.env.get('CAPPZ_LEGACY_SIGNED_FETCH') === '1', directory: o.directory });
  const hostname = Deno.env.get('CAPPZ_LEGACY_HOST') ?? '127.0.0.1';
  console.log(`[edge-node] legacy ${hostname}:${o.port}/legacy/v1  require ${policy.required.join(',')}  operators ${policy.operators.length}  scan ${scan ? 'on' : 'off'}`);
  void runPulls(o.dataDir, o.nodeAddress, store, policy, scan);
  Deno.serve({ port: o.port, hostname }, (req) => gw.handle(req));
  if (o.ftpsPort && o.tls) void serveFtps(o.ftpsPort, o.dataDir, o.tls, gw, policy.maxBytes);
  else if (o.ftpsPort) console.log('[edge-node] ftps off: needs TLS (CAPPZ_TLS_CERT/CAPPZ_TLS_KEY or CAPPZ_TLS_AUTO=1)');
}
