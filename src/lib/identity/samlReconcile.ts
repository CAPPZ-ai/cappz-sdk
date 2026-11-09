/**
 * COPE node crystallized.
 * Node ID: v15-36-00-saml-reconcile
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Every SaaS session should have a birth certificate. When a SaaS service
 * provider accepts a forged or replayed SAML assertion, its own audit log
 * still records a successful SSO login — but your identity provider (IdP)
 * never issued an assertion for it. Reconciliation finds exactly those
 * sessions from two read-only log exports, without any change to the SaaS
 * or the IdP and whatever bug the SP has:
 *
 *   issued  — the IdP's sign-in log (Okta System Log, Microsoft Entra
 *             sign-ins, ADFS, any CSV/JSON via a field mapping), or batches
 *             the edge node sealed as assertions were issued;
 *   logins  — the SaaS's own audit log of SSO logins (any CSV/JSON export).
 *
 * Each login is matched to an issuance for the same subject and application
 * (by assertion ID when both logs carry it, else the nearest unused issuance
 * within a window before the login). The result is one of:
 *   matched           an issuance accounts for it
 *   orphan            no issuance at all — a session your IdP never issued
 *   reused            the only issuances were already used (or the assertion ID was) — a replay
 *   unmapped-app      the IdP issued nothing for this application in the whole period —
 *                     a mapping gap or an app without SSO, reported as a gap, never as clean
 *   outside-coverage  outside the time range the IdP export covers
 * Nothing is dropped or defaulted: gaps are counted as their own state.
 *
 * Tamper evidence: an attacker who can forge assertions may also edit IdP
 * logs. sealIssuedBatch() hashes each issuance (salted subject, no NameID)
 * and signs the batch with the node's key as it is collected; reconciling
 * against sealed batches makes deleted issuance records visible.
 */

import { canonicalJson, sha256HexOf } from './canonical.ts';
import { signCanonical, verifyCanonical, type SigningKey } from '../sync/helloSignature.ts';

export interface IssuedAssertion { at: number; subject: string; app: string; assertionId?: string; source: string }
export interface SpLogin { at: number; subject: string; app: string; assertionId?: string; sessionId?: string; ip?: string; source: string }

export type LoginState = 'matched' | 'orphan' | 'reused' | 'unmapped-app' | 'outside-coverage';

export interface ReconcileOptions {
  /** How long before a login its assertion may have been issued (default 5 min). */
  windowBeforeMs?: number;
  /** Clock difference tolerated the other way (default 2 min). */
  skewMs?: number;
  /** One issuance accounts for one login (default true); logins of the same subject and app within dedupeMs count once. */
  oneToOne?: boolean;
  dedupeMs?: number;
  /** Map both sides' application names to one id (IdP app label → id, SaaS name → id). Unmapped names are lowercased. */
  apps?: Record<string, string>;
  /** Subject aliases (employee id → email …) — after lowercasing. */
  aliases?: Record<string, string>;
  /** Most finding rows kept in the report (counts are always complete). Default 1000. */
  maxRows?: number;
}

export interface ReconcileReport {
  period: { issuedFrom?: string; issuedTo?: string; loginsFrom?: string; loginsTo?: string };
  counts: Record<LoginState, number>;
  byApp: Record<string, Record<LoginState, number>>;
  findings: Array<{ state: Exclude<LoginState, 'matched'>; at: string; subject: string; app: string; assertionId?: string; sessionId?: string; ip?: string; source: string; because: string }>;
  verdict: 'clean' | 'findings' | 'gaps-only';
  summary: string;
  inputHashes: { issued: string; logins: string };
  reportHash: string;
}

const norm = (s: string) => s.trim().toLowerCase();
const zero = (): Record<LoginState, number> => ({ matched: 0, orphan: 0, reused: 0, 'unmapped-app': 0, 'outside-coverage': 0 });

export async function reconcileSamlLogins(issuedIn: readonly IssuedAssertion[], loginsIn: readonly SpLogin[], o: ReconcileOptions = {}): Promise<ReconcileReport> {
  const before = o.windowBeforeMs ?? 5 * 60_000;
  const skew = o.skewMs ?? 2 * 60_000;
  const oneToOne = o.oneToOne ?? true;
  const dedupe = o.dedupeMs ?? 10_000;
  const maxRows = o.maxRows ?? 1000;
  const app = (s: string) => { const k = norm(s); return o.apps?.[s] ?? o.apps?.[k] ?? k; };
  const subj = (s: string) => { const k = norm(s); return o.aliases?.[k] ?? k; };
  const issued = issuedIn.filter((x) => Number.isFinite(x.at)).map((x) => ({ ...x, subject: subj(x.subject), app: app(x.app), used: false })).sort((a, b) => a.at - b.at);
  const logins = loginsIn.filter((x) => Number.isFinite(x.at)).map((x) => ({ ...x, subject: subj(x.subject), app: app(x.app) })).sort((a, b) => a.at - b.at);

  const issuedFrom = issued[0]?.at; const issuedTo = issued[issued.length - 1]?.at;
  const appsIssued = new Set(issued.map((x) => x.app));
  const byKey = new Map<string, typeof issued>();
  for (const x of issued) { const k = `${x.subject}|${x.app}`; (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(x); }
  const byAssertion = new Map(issued.filter((x) => x.assertionId).map((x) => [`${x.app}|${x.assertionId}`, x]));
  const usedAssertions = new Set<string>();

  const counts = zero(); const byApp: Record<string, Record<LoginState, number>> = {}; const findings: ReconcileReport['findings'] = [];
  const lastLogin = new Map<string, number>();
  for (const l of logins) {
    const k = `${l.subject}|${l.app}`;
    const prev = lastLogin.get(k);
    if (prev !== undefined && l.at - prev <= dedupe && !l.assertionId) continue; // the same login logged twice
    lastLogin.set(k, l.at);
    let state: LoginState; let because = '';
    if (!appsIssued.has(l.app)) { state = 'unmapped-app'; because = 'the IdP export has no issuance for this application in the whole period: map its name (apps) or confirm it does not use SSO'; }
    else if (issuedFrom === undefined || l.at < issuedFrom - skew || l.at > issuedTo! + before) { state = 'outside-coverage'; because = 'outside the time range the IdP export covers'; }
    else if (l.assertionId) {
      const ak = `${l.app}|${l.assertionId}`; const hit = byAssertion.get(ak);
      if (usedAssertions.has(ak)) { state = 'reused'; because = 'this assertion ID already started a session'; }
      else if (hit && hit.subject === l.subject) { state = 'matched'; usedAssertions.add(ak); hit.used = true; }
      else if (hit) { state = 'orphan'; because = `the IdP issued this assertion ID to a different subject`; }
      else { state = 'orphan'; because = 'the IdP never issued this assertion ID'; }
    } else {
      const cands = (byKey.get(k) ?? []).filter((x) => x.at >= l.at - before && x.at <= l.at + skew);
      const free = cands.filter((x) => !x.used || !oneToOne);
      if (free.length) { const pick = free[free.length - 1]; pick.used = true; state = 'matched'; }
      else if (cands.length) { state = 'reused'; because = `the ${cands.length} issuance(s) in the window already accounted for other logins — one assertion, two sessions`; }
      else { state = 'orphan'; because = `no assertion was issued for this subject and application in the ${Math.round(before / 60_000)} min before the login — a session your IdP never issued`; }
    }
    counts[state]++;
    (byApp[l.app] ??= zero())[state]++;
    if (state !== 'matched' && findings.length < maxRows) findings.push({ state, at: new Date(l.at).toISOString(), subject: l.subject, app: l.app, assertionId: l.assertionId, sessionId: l.sessionId, ip: l.ip, source: l.source, because });
  }
  const bad = counts.orphan + counts.reused; const gaps = counts['unmapped-app'] + counts['outside-coverage'];
  const verdict = bad ? 'findings' : gaps ? 'gaps-only' : 'clean';
  const summary = bad
    ? `${bad} SaaS login(s) without a matching IdP issuance (${counts.orphan} orphan, ${counts.reused} reused) — investigate: revoke those sessions and check the SP's SAML validation`
    : gaps ? `no forged-login signal, but ${gaps} login(s) could not be reconciled (${counts['unmapped-app']} unmapped app, ${counts['outside-coverage']} outside coverage) — close the gaps before calling it clean`
      : `every one of ${counts.matched} SaaS login(s) matches an IdP issuance`;
  const iso = (t?: number) => (t === undefined ? undefined : new Date(t).toISOString());
  const body = {
    period: { issuedFrom: iso(issuedFrom), issuedTo: iso(issuedTo), loginsFrom: iso(logins[0]?.at), loginsTo: iso(logins[logins.length - 1]?.at) },
    counts, byApp, findings, verdict, summary,
    inputHashes: { issued: await sha256HexOf(canonicalJson(issuedIn)), logins: await sha256HexOf(canonicalJson(loginsIn)) },
  } as const;
  return { ...body, reportHash: await sha256HexOf(canonicalJson(body)) };
}

// ─── Log shapes ───────────────────────────────────────────────────

const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Okta System Log events (GET /api/v1/logs export): successful `user.authentication.sso` to an AppInstance. */
export function issuedFromOktaSystemLog(events: readonly unknown[]): IssuedAssertion[] {
  const out: IssuedAssertion[] = [];
  for (const e of events) {
    if (get(e, 'eventType') !== 'user.authentication.sso' || get(e, 'outcome.result') !== 'SUCCESS') continue;
    const targets = (get(e, 'target') as unknown[] | undefined) ?? [];
    const appT = targets.find((t) => get(t, 'type') === 'AppInstance');
    const subject = str(get(e, 'actor.alternateId')); const app = str(get(appT, 'displayName')) ?? str(get(appT, 'alternateId')); const at = Date.parse(String(get(e, 'published')));
    if (subject && app && Number.isFinite(at)) out.push({ at, subject, app, source: `okta:${str(get(e, 'uuid')) ?? ''}` });
  }
  return out;
}

/** Microsoft Entra sign-in log rows (Graph /auditLogs/signIns or the portal's JSON download): errorCode 0. */
export function issuedFromEntraSignIns(rows: readonly unknown[]): IssuedAssertion[] {
  const out: IssuedAssertion[] = [];
  for (const r of rows) {
    const code = get(r, 'status.errorCode'); if (code !== 0 && code !== '0') continue;
    const subject = str(get(r, 'userPrincipalName')); const app = str(get(r, 'appDisplayName')) ?? str(get(r, 'appId')); const at = Date.parse(String(get(r, 'createdDateTime')));
    if (subject && app && Number.isFinite(at)) out.push({ at, subject, app, source: `entra:${str(get(r, 'id')) ?? ''}` });
  }
  return out;
}

/** Any export, by naming its fields (dot paths); `where` keeps only successful SSO rows. */
export interface FieldMapping { at: string; subject: string; app: string | { constant: string }; assertionId?: string; sessionId?: string; ip?: string; where?: Record<string, string | readonly string[]>; source?: string }

function mapRows<T>(rows: readonly unknown[], m: FieldMapping, make: (base: { at: number; subject: string; app: string; assertionId?: string; sessionId?: string; ip?: string; source: string }) => T): T[] {
  const out: T[] = [];
  rows.forEach((r, i) => {
    for (const [k, want] of Object.entries(m.where ?? {})) { const v = String(get(r, k) ?? ''); if (Array.isArray(want) ? !want.includes(v) : v !== want) return; }
    const rawAt = get(r, m.at);
    const at = typeof rawAt === 'number' ? (rawAt < 1e12 ? rawAt * 1000 : rawAt) : Date.parse(String(rawAt));
    const subject = str(get(r, m.subject)); const app = typeof m.app === 'string' ? str(get(r, m.app)) : m.app.constant;
    if (!subject || !app || !Number.isFinite(at)) return;
    out.push(make({ at, subject, app, assertionId: m.assertionId ? str(get(r, m.assertionId)) : undefined, sessionId: m.sessionId ? str(get(r, m.sessionId)) : undefined, ip: m.ip ? str(get(r, m.ip)) : undefined, source: `${m.source ?? 'export'}:${i}` }));
  });
  return out;
}
export const issuedFromRecords = (rows: readonly unknown[], m: FieldMapping): IssuedAssertion[] => mapRows(rows, m, ({ at, subject, app, assertionId, source }) => ({ at, subject, app, assertionId, source }));
export const loginsFromRecords = (rows: readonly unknown[], m: FieldMapping): SpLogin[] => mapRows(rows, m, (b) => b);

/** RFC 4180 CSV → objects keyed by the header row. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"' && cell === '') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== '')) rows.push(row);
  const [head, ...body] = rows; if (!head) return [];
  const keys = head.map((h) => h.replace(/^﻿/, '').trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

// ─── Sealed issuance (tamper evidence) ────────────────────────────

export interface SealedIssuedBatch {
  v: 1; kind: 'cappz.saml.issued-batch';
  /** Previous batch hash: batches form a chain, so a removed batch is visible. */
  previous: string | null;
  from: string; to: string;
  /** sha256(salt|subject), app, sha256(salt|assertionId) — no NameID leaves the node. */
  items: Array<{ at: number; subjectHash: string; app: string; assertionIdHash?: string }>;
  signerKey: string; batchHash: string; signature: string;
}

const saltHash = (salt: string, v: string) => sha256HexOf(`${salt}|${v}`);

export async function sealIssuedBatch(issued: readonly IssuedAssertion[], o: { salt: string; previous: string | null; key: SigningKey; apps?: Record<string, string> }): Promise<SealedIssuedBatch> {
  const app = (s: string) => o.apps?.[s] ?? o.apps?.[norm(s)] ?? norm(s);
  const items = await Promise.all([...issued].sort((a, b) => a.at - b.at).map(async (x) => ({ at: x.at, subjectHash: await saltHash(o.salt, norm(x.subject)), app: app(x.app), ...(x.assertionId ? { assertionIdHash: await saltHash(o.salt, x.assertionId) } : {}) })));
  const from = new Date(items[0]?.at ?? 0).toISOString(); const to = new Date(items[items.length - 1]?.at ?? 0).toISOString();
  const unsigned = { v: 1 as const, kind: 'cappz.saml.issued-batch' as const, previous: o.previous, from, to, items, signerKey: o.key.publicKeyHex };
  const batchHash = await sha256HexOf(canonicalJson(unsigned));
  return { ...unsigned, batchHash, signature: await signCanonical(batchHash, o.key) };
}

/** Verify a chain of sealed batches (oldest first) from trusted node keys; returns their issuances with hashed subjects. */
export async function openSealedBatches(batches: readonly SealedIssuedBatch[], trustedKeys: readonly string[]): Promise<{ ok: boolean; because: string; issued: IssuedAssertion[] }> {
  let prev: string | null = batches[0]?.previous ?? null; const issued: IssuedAssertion[] = [];
  for (const [i, b] of batches.entries()) {
    if (!trustedKeys.includes(b.signerKey)) return { ok: false, because: `batch ${i}: signer not trusted`, issued };
    const { batchHash, signature, ...unsigned } = b;
    if ((await sha256HexOf(canonicalJson(unsigned))) !== batchHash) return { ok: false, because: `batch ${i}: contents changed after sealing`, issued };
    if (!(await verifyCanonical(batchHash, signature, b.signerKey).catch(() => false))) return { ok: false, because: `batch ${i}: bad signature`, issued };
    if (i > 0 && b.previous !== prev) return { ok: false, because: `batch ${i}: chain broken (a batch is missing or reordered)`, issued };
    prev = batchHash;
    for (const x of b.items) issued.push({ at: x.at, subject: x.subjectHash, app: x.app, assertionId: x.assertionIdHash, source: `sealed:${batchHash.slice(0, 12)}` });
  }
  return { ok: true, because: `${batches.length} batch(es) verified`, issued };
}

/** Hash a SaaS login export the same way, to reconcile it against sealed batches. */
export async function hashLogins(logins: readonly SpLogin[], salt: string, aliases?: Record<string, string>): Promise<SpLogin[]> {
  return Promise.all(logins.map(async (l) => { const s = norm(l.subject); return { ...l, subject: await saltHash(salt, aliases?.[s] ?? s), assertionId: l.assertionId ? await saltHash(salt, l.assertionId) : undefined }; }));
}
