/**
 * COPE node crystallized.
 * Node ID: v15-10-00-ldap-directory
 * Provenance: m/44'/144'/100'/principles/cope/v1
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Read-only LDAPv3 face of the directory view (directoryView.ts), for
 * enterprise clients that look names up in LDAP (ldapsearch, address books,
 * monitoring). The ontology stays the source: entries are the projected rows,
 * placed under ou=<ontology parent address>, or ou=unplaced. Nothing is
 * written; bind is anonymous only (a bind with credentials is refused — this
 * face holds no passwords). Labels are display attributes only.
 *
 *   dn: cn=<deviceId>,ou=<parent>,<base>
 *   objectClass: top, device, cappzDevice
 *   cn, cappzWallet, cappzCopy, cappzAddress, cappzEndpoint, cappzCarrier, cappzTrust,
 *   displayName (alias), description
 *
 * BER subset: BindRequest, UnbindRequest, SearchRequest (scopes base / one /
 * sub; filters and, or, not, equality, present, substrings), the root DSE.
 * Every request gets a response; unknown operations get unwillingToPerform.
 */

import type { DirectoryRow } from './directoryView.ts';

// ─── BER ─────────────────────────────────────────────────────────

const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
function len(n: number): Uint8Array { if (n < 0x80) return Uint8Array.of(n); const b: number[] = []; while (n > 0) { b.unshift(n & 0xff); n >>= 8; } return Uint8Array.of(0x80 | b.length, ...b); }
const tlv = (tag: number, c: Uint8Array) => cat(Uint8Array.of(tag), len(c.length), c);
const str = (s: string, tag = 0x04) => tlv(tag, new TextEncoder().encode(s));
function int(n: number, tag = 0x02): Uint8Array { const b: number[] = []; do { b.unshift(n & 0xff); n >>= 8; } while (n > 0); if (b[0] & 0x80) b.unshift(0); return tlv(tag, Uint8Array.from(b)); }

interface Node { tag: number; start: number; end: number; next: number }
function read(b: Uint8Array, at: number): Node | null {
  if (at + 2 > b.length) return null;
  const tag = b[at]; let l = b[at + 1]; let p = at + 2;
  if (l & 0x80) { const n = l & 0x7f; if (n > 4 || p + n > b.length) return null; l = 0; for (let i = 0; i < n; i++) l = l * 256 + b[p++]; }
  if (p + l > b.length) return null;
  return { tag, start: p, end: p + l, next: p + l };
}
function kids(b: Uint8Array, n: Node): Node[] { const out: Node[] = []; for (let p = n.start; p < n.end;) { const c = read(b, p); if (!c) break; out.push(c); p = c.next; } return out; }
const text = (b: Uint8Array, n: Node) => new TextDecoder().decode(b.subarray(n.start, n.end));
const num = (b: Uint8Array, n: Node) => { let v = 0; for (let i = n.start; i < n.end; i++) v = v * 256 + b[i]; return v; };

/** Split a buffer into complete LDAP messages; returns them and the unconsumed rest. */
export function splitMessages(buf: Uint8Array): { messages: Uint8Array[]; rest: Uint8Array } {
  const messages: Uint8Array[] = []; let at = 0;
  for (;;) { const n = read(buf, at); if (!n || n.tag !== 0x30) break; messages.push(buf.slice(at, n.next)); at = n.next; }
  return { messages, rest: buf.slice(at) };
}

// ─── Filters ─────────────────────────────────────────────────────

type Filter =
  | { and: Filter[] } | { or: Filter[] } | { not: Filter }
  | { eq: [string, string] } | { present: string } | { sub: { attr: string; initial?: string; any: string[]; final?: string } }
  | { unsupported: true };

function parseFilter(b: Uint8Array, n: Node): Filter {
  switch (n.tag) {
    case 0xa0: return { and: kids(b, n).map((k) => parseFilter(b, k)) };
    case 0xa1: return { or: kids(b, n).map((k) => parseFilter(b, k)) };
    case 0xa2: return { not: parseFilter(b, kids(b, n)[0]) };
    case 0xa3: { const [a, v] = kids(b, n); return { eq: [text(b, a).toLowerCase(), text(b, v)] }; }
    case 0x87: return { present: text(b, n).toLowerCase() };
    case 0xa4: {
      const [a, seq] = kids(b, n); const sub = { attr: text(b, a).toLowerCase(), any: [] as string[], initial: undefined as string | undefined, final: undefined as string | undefined };
      for (const k of kids(b, seq)) { if (k.tag === 0x80) sub.initial = text(b, k); else if (k.tag === 0x81) sub.any.push(text(b, k)); else if (k.tag === 0x82) sub.final = text(b, k); }
      return { sub };
    }
    default: return { unsupported: true };
  }
}

type Entry = { dn: string; attrs: Record<string, string[]> };

function matches(f: Filter, e: Entry): boolean {
  const vals = (a: string) => Object.entries(e.attrs).find(([k]) => k.toLowerCase() === a)?.[1] ?? [];
  if ('and' in f) return f.and.every((x) => matches(x, e));
  if ('or' in f) return f.or.some((x) => matches(x, e));
  if ('not' in f) return !matches(f.not, e);
  if ('present' in f) return f.present === 'objectclass' || vals(f.present).length > 0;
  if ('eq' in f) return vals(f.eq[0]).some((v) => v.toLowerCase() === f.eq[1].toLowerCase());
  if ('sub' in f) return vals(f.sub.attr).some((v0) => {
    let v = v0.toLowerCase(); const s = f.sub;
    if (s.initial) { if (!v.startsWith(s.initial.toLowerCase())) return false; v = v.slice(s.initial.length); }
    for (const a of s.any) { const i = v.indexOf(a.toLowerCase()); if (i < 0) return false; v = v.slice(i + a.length); }
    return !s.final || v.endsWith(s.final.toLowerCase());
  });
  return false;
}

// ─── Directory ───────────────────────────────────────────────────

/** RFC 4514 value escaping for the DN parts we build. */
export function escapeDnValue(v: string): string {
  return v.replace(/[\\,+"<>;=]/g, (c) => `\\${c}`).replace(/^([ #])/, '\\$1').replace(/ $/, '\\ ');
}

export function directoryEntries(rows: readonly DirectoryRow[], base: string): Entry[] {
  const parents = new Map<string, Entry>();
  const out: Entry[] = [{ dn: base, attrs: { objectClass: ['top', 'organization'], o: ['CAPPZ directory'], description: ['Projected from the wallet ontology and member records; read-only'] } }];
  for (const r of rows) {
    const ou = escapeDnValue(r.parent);
    if (!parents.has(ou)) { const p = { dn: `ou=${ou},${base}`, attrs: { objectClass: ['top', 'organizationalUnit'], ou: [r.parent] } }; parents.set(ou, p); out.push(p); }
    out.push({
      dn: `cn=${escapeDnValue(r.deviceId)},ou=${ou},${base}`,
      attrs: {
        objectClass: ['top', 'device', 'cappzDevice'], cn: [r.deviceId], cappzWallet: [r.walletAddress], cappzCopy: [r.copyId], cappzAddress: [r.address],
        cappzEndpoint: r.endpoints.map((e) => e.url), cappzCarrier: [...new Set(r.endpoints.flatMap((e) => e.carriers))], cappzTrust: [r.trust],
        ...(r.name ? { displayName: [r.name] } : {}), ...(r.description ? { description: [r.description] } : {}),
      },
    });
  }
  return out;
}

/** RDNs in a DN prefix: commas not escaped with a backslash (no look-behind: older Safari cannot parse it). */
function rdnCount(dn: string): number {
  let n = 1;
  for (let i = 0; i < dn.length; i++) { if (dn[i] === '\\') i++; else if (dn[i] === ',') n++; }
  return n;
}

const norm = (dn: string) => dn.split(',').map((p) => p.trim().toLowerCase()).join(',');
function inScope(e: Entry, base: string, scope: number): boolean {
  const d = norm(e.dn); const b = norm(base);
  if (scope === 0) return d === b;
  if (!(d === b || d.endsWith(`,${b}`))) return false;
  if (scope === 1) return d !== b && rdnCount(d.slice(0, d.length - b.length - 1)) === 1;
  return true;
}

const result = (msgId: number, appTag: number, code: number, diag = '') => tlv(0x30, cat(int(msgId), tlv(appTag, cat(int(code, 0x0a), str(''), str(diag)))));

export interface LdapOptions { base: string; rows: () => Promise<readonly DirectoryRow[]>; sizeLimit?: number }

/** Answer one LDAP message. Returns the response messages and whether to close (unbind). */
export async function answerLdap(msg: Uint8Array, o: LdapOptions): Promise<{ responses: Uint8Array[]; close: boolean }> {
  const top = read(msg, 0);
  if (!top) return { responses: [], close: true };
  const [idN, op] = kids(msg, top);
  if (!idN || !op) return { responses: [], close: true };
  const id = num(msg, idN);
  if (op.tag === 0x42) return { responses: [], close: true }; // UnbindRequest
  if (op.tag === 0x60) { // BindRequest
    const [, name, auth] = kids(msg, op);
    const anonymous = text(msg, name) === '' && auth && auth.tag === 0x80 && auth.end === auth.start;
    return { responses: [result(id, 0x61, anonymous ? 0 : 48, anonymous ? '' : 'read-only directory: anonymous bind only')], close: false };
  }
  if (op.tag === 0x63) { // SearchRequest
    const [baseN, scopeN, , sizeN, , typesOnlyN, filterN, attrsN] = kids(msg, op);
    const base = text(msg, baseN); const scope = num(msg, scopeN);
    const filter = parseFilter(msg, filterN);
    const typesOnly = typesOnlyN ? msg[typesOnlyN.start] !== 0 : false;
    const wanted = attrsN ? kids(msg, attrsN).map((k) => text(msg, k).toLowerCase()).filter((a) => a && a !== '*') : [];
    const out: Uint8Array[] = [];
    const encode = (e: Entry) => tlv(0x30, cat(int(id), tlv(0x64, cat(str(e.dn), tlv(0x30, cat(...Object.entries(e.attrs)
      .filter(([k]) => !wanted.length || wanted.includes(k.toLowerCase()))
      .map(([k, vs]) => tlv(0x30, cat(str(k), tlv(0x31, cat(...(typesOnly ? [] : vs.map((v) => str(v))))))))))))));
    if (base === '' && scope === 0) { // root DSE
      out.push(encode({ dn: '', attrs: { objectClass: ['top'], namingContexts: [o.base], supportedLDAPVersion: ['3'], vendorName: ['CAPPZ'], vendorVersion: ['v15-10-00 read-only directory'] } }));
      out.push(result(id, 0x65, 0));
      return { responses: out, close: false };
    }
    if ('unsupported' in filter) return { responses: [result(id, 0x65, 53, 'filter type not supported (and, or, not, equality, present, substrings are)')], close: false };
    const entries = directoryEntries(await o.rows(), o.base);
    if (!entries.some((e) => norm(e.dn) === norm(base))) return { responses: [result(id, 0x65, 32, 'no such entry')], close: false };
    const limit = Math.min(num(msg, sizeN) || Infinity, o.sizeLimit ?? 1000);
    let n = 0;
    for (const e of entries) {
      if (!inScope(e, base, scope) || !matches(filter, e)) continue;
      if (n >= limit) { out.push(result(id, 0x65, 4, 'size limit exceeded')); return { responses: out, close: false }; }
      out.push(encode(e)); n++;
    }
    out.push(result(id, 0x65, 0));
    return { responses: out, close: false };
  }
  // Any other operation (add, modify, delete, extended…): this face is read-only.
  const respTag = op.tag === 0x77 ? 0x78 : op.tag === 0x66 ? 0x67 : op.tag === 0x68 ? 0x69 : op.tag === 0x4a ? 0x6b : op.tag === 0x6c ? 0x6d : op.tag === 0x6e ? 0x6f : 0x78;
  return { responses: [result(id, respTag, 53, 'read-only directory')], close: false };
}

/** Client-side helpers (tests and SDK users without an LDAP library). */
export const ldapClient = {
  bind: (id: number, name = '') => tlv(0x30, cat(int(id), tlv(0x60, cat(int(3), str(name), tlv(0x80, new Uint8Array()))))),
  search: (id: number, base: string, scope: 0 | 1 | 2, filter: Uint8Array, attrs: string[] = []) =>
    tlv(0x30, cat(int(id), tlv(0x63, cat(str(base), int(scope, 0x0a), int(0, 0x0a), int(0), int(0), tlv(0x01, Uint8Array.of(0)), filter, tlv(0x30, cat(...attrs.map((a) => str(a)))))))),
  present: (attr: string) => str(attr, 0x87),
  eq: (attr: string, value: string) => tlv(0xa3, cat(str(attr), str(value))),
  and: (...f: Uint8Array[]) => tlv(0xa0, cat(...f)),
  /** Decode SearchResultEntry messages into { dn, attrs }; returns the final result code. */
  decode(responses: Uint8Array[]): { entries: Entry[]; code: number | null } {
    const entries: Entry[] = []; let code: number | null = null;
    for (const m of responses) {
      const top = read(m, 0)!; const [, op] = kids(m, top);
      if (op.tag === 0x64) {
        const [dnN, attrsN] = kids(m, op); const attrs: Record<string, string[]> = {};
        for (const a of kids(m, attrsN)) { const [t, vs] = kids(m, a); attrs[text(m, t)] = kids(m, vs).map((v) => text(m, v)); }
        entries.push({ dn: text(m, dnN), attrs });
      } else if (op.tag === 0x65 || op.tag === 0x61) code = num(m, kids(m, op)[0]);
    }
    return { entries, code };
  },
};
