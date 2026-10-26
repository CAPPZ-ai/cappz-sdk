/**
 * COPE node crystallized.
 * Node ID: v15-09-00-legacy-gateway
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Legacy front end for senders and clients that do not speak CPZ1 — the
 * PHP scripts, cron jobs and partner systems that used FTP drops and raw
 * HTTP POSTs. One Fetch-API handler (runs on the edge node, in tests and in a
 * browser demo), REST/JSON:
 *
 *   POST|PUT /legacy/v1/drop/<name>     file in → quarantine → receipt
 *   GET      /legacy/v1/receipts/<sha>   where a file stands, with every check
 *   GET      /legacy/v1/released         directory listing of released files (?format=text)
 *   GET      /legacy/v1/objects/<sha>    a released file's bytes (internal clients)
 *   POST     /legacy/v1/decide/<sha>     operator release/reject (signed by a listed operator)
 *   GET      /legacy/v1/directory        the node's directory view (member table + ontology metadata)
 *
 * Upgrade path, nothing breaks on the way: an unsigned drop works (sender
 * check 'not-evaluated'); the same drop signed with HTTP Message Signatures
 * (edgeVerify.ts) passes the sender check; a sender that adopts CPZ1 moves to
 * the relay and replicates directly. Every drop gets a receipt (hash, checks,
 * decision) — FTP never gave one.
 */

import { intakeQuarantined, operatorDecision, replayQuarantine, DEFAULT_QUARANTINE_POLICY, type QuarantinePolicy, type QuarantineEntry, type QuarantineSource, type CheckName, type CheckResult } from '../quarantine.ts';
import type { UnsignedEdgeTx } from '../../functions/edgeJobs.ts';
import { readBounded, type VerifyGateway } from '../../identity/edgeVerify.ts';
import { transportTypeAddress } from '../../wallets/paths.ts';

export interface QuarantineStore {
  /** Hold bytes by hash outside the replicated body store. */
  hold(sha256: string, bytes: Uint8Array): Promise<void>;
  held(sha256: string): Promise<Uint8Array | null>;
  /** Move held bytes into the node's content-addressed body store (released). */
  release(sha256: string): Promise<void>;
  /** Drop held bytes (rejected); the TX history stays. */
  discard(sha256: string): Promise<void>;
  released(sha256: string): Promise<Uint8Array | null>;
  /** Sign and append to the node's TX log; read it back. */
  append(txs: UnsignedEdgeTx[]): Promise<void>;
  log(): Promise<UnsignedEdgeTx[]>;
}

export interface LegacyGatewayOptions {
  nodeAddress: string;
  store: QuarantineStore;
  policy?: QuarantinePolicy;
  /** Verifies signed drops and operator decisions; without it every request is unsigned. */
  verify?: VerifyGateway;
  /** Optional external scanner (ClamAV, ICAP…): its result becomes the malware-scan check. */
  scan?: (bytes: Uint8Array, sha256: string) => Promise<{ result: CheckResult; reason: string }>;
  /** Internal clients must sign fetches (recommended once they can). */
  requireSignedFetch?: boolean;
  directory?: () => Promise<unknown>;
  maxBytes?: number;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const SHA = /^[0-9a-f]{64}$/;

export function createLegacyGateway(o: LegacyGatewayOptions) {
  const policy = o.policy ?? DEFAULT_QUARANTINE_POLICY;
  const maxBytes = o.maxBytes ?? policy.maxBytes;

  const entries = async (): Promise<QuarantineEntry[]> => replayQuarantine(await o.store.log(), policy);
  const entry = async (sha: string) => (await entries()).find((e) => e.sha256 === sha) ?? null;

  /** One file in from any legacy carrier (HTTP drop, FTPS server, FTPS/SFTP pull): quarantine, checks, decision, receipt. */
  async function intakeFile(f: { bytes: Uint8Array; name: string; declaredType?: string; source: QuarantineSource }): Promise<{ status: number; receipt: ReturnType<typeof receipt> & { duplicate?: boolean } }> {
    if (f.bytes.length > maxBytes) return { status: 413, receipt: { error: `file is ${f.bytes.length} bytes; this node takes at most ${maxBytes}` } as never };
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', f.bytes.slice().buffer)), (b) => b.toString(16).padStart(2, '0')).join('');
    const prior = await entry(sha);
    if (prior) return { status: 200, receipt: { ...receipt(prior), duplicate: true } }; // same bytes again: one record, same receipt
    const external: Partial<Record<CheckName, { result: CheckResult; reason: string }>> = {};
    if (o.scan) { try { external['malware-scan'] = await o.scan(f.bytes, sha); } catch (e) { external['malware-scan'] = { result: 'not-evaluated', reason: `scanner error: ${e instanceof Error ? e.message : e}` }; } }
    const r = await intakeQuarantined({ nodeAddress: o.nodeAddress, bytes: f.bytes, name: f.name, declaredType: f.declaredType, policy, external, source: f.source });
    await o.store.hold(sha, f.bytes);
    await o.store.append(r.txs);
    if (r.decision === 'released') await o.store.release(sha);
    if (r.decision === 'rejected') await o.store.discard(sha);
    return { status: r.decision === 'released' ? 201 : r.decision === 'held' ? 202 : 422, receipt: receipt((await entry(sha))!) };
  }

  async function drop(req: Request, name: string): Promise<Response> {
    // Bounded read: a chunked body without Content-Length is cut off at the limit, never buffered whole.
    const bytes = await readBounded(req, maxBytes);
    if (!bytes) return json({ error: `file is larger than this node takes (${maxBytes} bytes)` }, 413);
    const signed = req.headers.has('signature-input') || req.headers.has('x-ssl-client-cert');
    const verdict = signed && o.verify ? await o.verify.verifyRequest(req, bytes) : undefined;
    const digest = /sha-256=:([A-Za-z0-9+/=]+):/.exec(req.headers.get('content-digest') ?? '');
    const declaredSha256 = digest ? Array.from(Uint8Array.from(atob(digest[1]), (c) => c.charCodeAt(0)), (b) => b.toString(16).padStart(2, '0')).join('') : undefined;
    const r = await intakeFile({
      bytes, name: decodeURIComponent(name), declaredType: req.headers.get('content-type') ?? undefined,
      source: {
        kind: 'http-drop', transportType: transportTypeAddress('http-drop'), declaredSha256,
        ...(verdict ? { verdict: { signature: verdict.signature, trust: verdict.trust, content: verdict.content, walletAddress: verdict.walletAddress, keyId: verdict.keyId }, sender: verdict.walletAddress } : {}),
      },
    });
    return json(r.receipt, r.status);
  }

  function receipt(e: QuarantineEntry) {
    return { sha256: e.sha256, name: e.name, size: e.size, detectedType: e.detectedType, state: e.state, because: e.because, decidedBy: e.decidedBy ?? null, checks: e.checks, receivedAt: e.receivedAt, receipt: `/legacy/v1/receipts/${e.sha256}` };
  }

  async function signedOk(req: Request): Promise<{ ok: boolean; wallet?: string; why?: string }> {
    if (!o.verify) return { ok: false, why: 'this node verifies no signatures' };
    const body = await readBounded(req.clone(), 64 * 1024);
    if (!body) return { ok: false, why: 'body too large' };
    const v = await o.verify.verifyRequest(req, body);
    return v.allowed && ['declared', 'delegated', 'operator-listed'].includes(v.trust) ? { ok: true, wallet: v.walletAddress } : { ok: false, why: `${v.signature}, key ${v.trust}` };
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/legacy\/v1\/([a-z]+)(?:\/(.+))?$/.exec(url.pathname);
    if (!m) return json({ error: 'not found' }, 404);
    const [, route, rest] = m;
    if (route === 'drop' && (req.method === 'POST' || req.method === 'PUT') && rest && !rest.includes('/')) return drop(req, rest);
    if (route === 'receipts' && req.method === 'GET' && rest && SHA.test(rest)) { const e = await entry(rest); return e ? json(receipt(e)) : json({ error: 'no such file' }, 404); }
    if (route === 'released' && req.method === 'GET') {
      if (o.requireSignedFetch) { const s = await signedOk(req); if (!s.ok) return json({ error: `signed fetch required: ${s.why}` }, 401); }
      const list = (await entries()).filter((e) => e.state === 'released').map((e) => ({ sha256: e.sha256, name: e.name, size: e.size, type: e.detectedType, receivedAt: e.receivedAt, decidedBy: e.decidedBy }));
      if (url.searchParams.get('format') === 'text') return new Response(list.map((e) => `${e.sha256}  ${e.size}  ${e.name}`).join('\n') + (list.length ? '\n' : ''), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return json({ files: list });
    }
    if (route === 'objects' && req.method === 'GET' && rest && SHA.test(rest)) {
      if (o.requireSignedFetch) { const s = await signedOk(req); if (!s.ok) return json({ error: `signed fetch required: ${s.why}` }, 401); }
      const e = await entry(rest);
      if (!e || e.state !== 'released') return json({ error: e ? `file is ${e.state}, not released` : 'no such file' }, e ? 409 : 404);
      const bytes = await o.store.released(rest);
      if (!bytes) return json({ error: 'released record found but the bytes are missing on this node' }, 410);
      return new Response(bytes as BodyInit, { headers: { 'content-type': e.detectedType, 'content-disposition': `attachment; filename="${e.name.replace(/"/g, '')}"`, etag: `"${e.sha256}"`, 'cappz-content-sha256': e.sha256 } });
    }
    if (route === 'decide' && req.method === 'POST' && rest && SHA.test(rest)) {
      const s = await signedOk(req);
      if (!s.ok || !s.wallet) return json({ error: `operator decisions must be signed by a declared key: ${s.why}` }, 401);
      let body: { decision?: string; because?: string };
      try { body = await req.json(); } catch { return json({ error: 'JSON body { decision: release|reject, because }' }, 400); }
      if (body.decision !== 'release' && body.decision !== 'reject') return json({ error: 'decision must be release or reject' }, 400);
      const e = await entry(rest);
      if (!e) return json({ error: 'no such file' }, 404);
      if (e.state === 'rejected' && body.decision === 'release' && !(await o.store.held(rest))) return json({ error: 'rejected bytes were discarded; ask the sender to drop the file again' }, 409);
      let t: UnsignedEdgeTx;
      try { t = operatorDecision(o.nodeAddress, rest, body.decision, s.wallet, String(body.because ?? ''), policy); } catch (err) { return json({ error: err instanceof Error ? err.message : String(err) }, 403); }
      await o.store.append([t]);
      if (body.decision === 'release') await o.store.release(rest); else await o.store.discard(rest);
      return json(receipt((await entry(rest))!));
    }
    if (route === 'directory' && req.method === 'GET') return o.directory ? json(await o.directory()) : json({ error: 'no directory on this node' }, 404);
    return json({ error: 'not found' }, 404);
  }

  return { handle, entries, intakeFile };
}

/** In-memory store (tests, browser demos). */
export function memoryQuarantineStore(): QuarantineStore & { txs: UnsignedEdgeTx[] } {
  const held = new Map<string, Uint8Array>(); const rel = new Map<string, Uint8Array>(); const txs: UnsignedEdgeTx[] = [];
  return {
    txs,
    hold: async (s, b) => { held.set(s, b); },
    held: async (s) => held.get(s) ?? null,
    release: async (s) => { const b = held.get(s); if (b) { rel.set(s, b); held.delete(s); } },
    discard: async (s) => { held.delete(s); },
    released: async (s) => rel.get(s) ?? null,
    append: async (t) => { txs.push(...t); },
    log: async () => [...txs],
  };
}
