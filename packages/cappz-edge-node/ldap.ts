/**
 * COPE node crystallized.
 * Node ID: v15-10-00-edge-node-ldap
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * --ldap <port> (default 41389): read-only LDAPv3 face of the node's directory
 * view (src/lib/sync/ldapDirectory.ts). Anonymous bind, search only.
 * CAPPZ_LDAP_HOST defaults to 127.0.0.1: the directory lists LAN endpoints, so
 * expose it beyond the host deliberately (or behind an LDAPS proxy).
 * CAPPZ_LDAP_BASE names the base DN (default dc=cappz).
 *
 *   ldapsearch -x -H ldap://127.0.0.1:41389 -b dc=cappz '(objectClass=cappzDevice)'
 */

import { answerLdap, splitMessages } from '../../src/lib/sync/ldapDirectory.ts';
import type { DirectoryRow } from '../../src/lib/sync/directoryView.ts';

export async function serveLdap(port: number, rows: () => Promise<readonly DirectoryRow[]>): Promise<void> {
  const hostname = Deno.env.get('CAPPZ_LDAP_HOST') ?? '127.0.0.1';
  const base = Deno.env.get('CAPPZ_LDAP_BASE') ?? 'dc=cappz';
  const listener = Deno.listen({ port, hostname });
  console.log(`[edge-node] ldap ${hostname}:${port}  base ${base} (read-only, anonymous)`);
  for await (const conn of listener) {
    (async () => {
      let pending: Uint8Array = new Uint8Array(0); const buf = new Uint8Array(16 * 1024);
      for (;;) {
        const r = await conn.read(buf);
        if (r === null) break;
        const joined = new Uint8Array(pending.length + r); joined.set(pending); joined.set(buf.subarray(0, r), pending.length);
        if (joined.length > 256 * 1024) break; // no request is this large
        const { messages, rest } = splitMessages(joined); pending = rest;
        for (const m of messages) {
          const a = await answerLdap(m, { base, rows });
          for (const resp of a.responses) await conn.write(resp);
          if (a.close) return;
        }
      }
    })().catch((err) => console.warn('[edge-node] ldap session ended:', err?.message ?? err)).finally(() => { try { conn.close(); } catch { /* closed */ } });
  }
}
