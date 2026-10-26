/**
 * COPE node crystallized.
 * Node ID: v15-10-00-ftps-server
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * FTPS server face for legacy senders that can only push by FTP (bank and
 * partner batch jobs). Every upload goes straight into the DMZ quarantine
 * (legacyGateway.intakeFile): same checks, same receipt, nothing is executed
 * or served back except the released listing. This is the session logic only;
 * the node supplies TLS sockets (implicit FTPS: TLS from the first byte on the
 * control and data connections — packages/cappz-edge-node/ftps.ts).
 *
 * Accounts name an environment variable holding the password
 * (<CAPPZ_NODE_DATA>/ftp-accounts.json: [{ user, passEnv, sender? }]);
 * passwords never sit in files or TXs. Comparison is constant-time. Three
 * failed logins close the connection.
 *
 * Supported: USER PASS PBSZ PROT TYPE MODE STRU SYST FEAT OPTS PWD CWD CDUP
 * EPSV PASV STOR NLST LIST SIZE NOOP QUIT. Refused: anything that reads or
 * changes files (RETR, DELE, RNFR, MKD…) — the drop box is write-only, as an
 * FTP drop folder was.
 */

import type { QuarantineSource } from '../quarantine.ts';
import { transportTypeAddress } from '../../wallets/paths.ts';

export interface FtpAccount { user: string; passEnv: string; sender?: string }

export interface FtpIo {
  /** Open a passive data listener; returns where the client should connect. */
  openPassive(): Promise<{ host: string; port: number }>;
  /** Read the whole upload from the data connection (closes it). Rejects above max bytes. */
  readData(maxBytes: number): Promise<Uint8Array>;
  /** Write a listing over the data connection (closes it). */
  writeData(bytes: Uint8Array): Promise<void>;
  /** Send a preliminary reply now (150 before a transfer: clients wait for it before using the data connection). */
  preliminary(line: string): Promise<void>;
  remote: string;
}

export interface FtpSessionOptions {
  accounts: readonly FtpAccount[];
  env: Record<string, string | undefined>;
  maxBytes: number;
  store(file: { bytes: Uint8Array; name: string; source: QuarantineSource }): Promise<{ status: number; receipt: { sha256?: string; state?: string; because?: string } }>;
  released(): Promise<Array<{ name: string; size: number; sha256: string }>>;
}

export function safeFtpName(arg: string): string | null {
  const name = arg.replace(/^\/+/, '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.length > 200 || /[\x00-\x1f]/.test(name)) return null;
  return name;
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a); const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function createFtpSession(o: FtpSessionOptions) {
  let user: FtpAccount | null = null;
  let pendingUser: string | null = null;
  let failures = 0;
  let passive = false;

  const greeting = '220 CAPPZ DMZ drop box (FTPS). Uploads are quarantined and checked; you get a receipt.';

  /** Returns the replies to send, in order; 'close' ends the session after them. */
  async function handle(line: string, io: FtpIo): Promise<{ replies: string[]; close?: boolean }> {
    const m = /^([A-Za-z]{3,4})(?: (.*))?$/.exec(line.replace(/\r?\n$/, ''));
    if (!m) return { replies: ['500 Syntax error'] };
    const cmd = m[1].toUpperCase(); const arg = m[2] ?? '';
    const r = (...replies: string[]) => ({ replies });
    switch (cmd) {
      case 'USER': pendingUser = arg; user = null; return r('331 Password required');
      case 'PASS': {
        const acct = o.accounts.find((a) => a.user === pendingUser);
        const want = acct ? o.env[acct.passEnv] : undefined;
        // Always compare (even for unknown users) so timing does not reveal which users exist.
        const ok = constantTimeEqual(arg, want ?? '\u0000no-password') && Boolean(acct && want);
        if (!ok) { failures++; return failures >= 3 ? { replies: ['530 Login incorrect; closing'], close: true } : r('530 Login incorrect'); }
        user = acct!; return r('230 Logged in; drops go to quarantine');
      }
      case 'QUIT': return { replies: ['221 Bye'], close: true };
      case 'NOOP': return r('200 OK');
      case 'SYST': return r('215 UNIX Type: L8');
      case 'FEAT': return r('211-Features', ' EPSV', ' PASV', ' PBSZ', ' PROT', ' SIZE', ' UTF8', '211 End');
      case 'OPTS': return r(arg.toUpperCase().startsWith('UTF8') ? '200 UTF8 on' : '501 Option not supported');
      case 'PBSZ': return r('200 PBSZ=0');
      case 'PROT': return r(arg.toUpperCase() === 'P' ? '200 Data protection private' : '536 Only PROT P (TLS) is offered');
      case 'AUTH': return r('534 This server speaks implicit FTPS: TLS is already on');
    }
    if (!user) return r('530 Log in first');
    switch (cmd) {
      case 'TYPE': return r(/^[AI]/i.test(arg) ? `200 Type set to ${arg.toUpperCase()}` : '504 Type not supported');
      case 'MODE': return r(arg.toUpperCase() === 'S' ? '200 Mode S' : '504 Only stream mode');
      case 'STRU': return r(arg.toUpperCase() === 'F' ? '200 Structure F' : '504 Only file structure');
      case 'PWD': return r('257 "/" is the drop box');
      case 'CWD': return r(arg === '/' || arg === '' || arg === '.' ? '250 OK' : '550 The drop box has no subdirectories');
      case 'CDUP': return r('250 OK');
      case 'EPSV': { const p = await io.openPassive(); passive = true; return r(`229 Entering Extended Passive Mode (|||${p.port}|)`); }
      case 'PASV': {
        const p = await io.openPassive(); passive = true;
        const h = /^\d+\.\d+\.\d+\.\d+$/.test(p.host) ? p.host.split('.').join(',') : '127,0,0,1';
        return r(`227 Entering Passive Mode (${h},${p.port >> 8},${p.port & 0xff})`);
      }
      case 'SIZE': return r('550 Files in the drop box are not readable back');
      case 'STOR': {
        const name = safeFtpName(arg);
        if (!name) return r('553 File name not allowed');
        if (!passive) return r('425 Use EPSV or PASV first');
        passive = false;
        await io.preliminary('150 Receiving');
        let bytes: Uint8Array;
        try { bytes = await io.readData(o.maxBytes); } catch (e) { return r(`552 ${e instanceof Error ? e.message : 'upload refused'}`); }
        const res = await o.store({ bytes, name, source: { kind: 'ftps-push', transportType: transportTypeAddress('ftps'), sender: user.sender ?? `ftp:${user.user}`, remote: io.remote } });
        const rc = res.receipt;
        const tail = `${rc.state ?? 'refused'} sha256=${rc.sha256 ?? '-'}${rc.because ? ` (${rc.because})` : ''}`;
        // 226 = received and released; 250 = received, held or rejected — the reply says which, the receipt has the checks.
        return r(res.status === 201 || res.status === 200 ? `226 Received: ${tail}` : res.status === 202 ? `250 Received, held: ${tail}` : `250 Received, rejected: ${tail}`);
      }
      case 'NLST': case 'LIST': {
        if (!passive) return r('425 Use EPSV or PASV first');
        passive = false;
        await io.preliminary('150 Listing released files');
        const files = await o.released();
        const text = files.map((f) => (cmd === 'NLST' ? f.name : `-r--r--r-- 1 cappz cappz ${f.size} Jan 01 00:00 ${f.name}`)).join('\r\n') + (files.length ? '\r\n' : '');
        await io.writeData(new TextEncoder().encode(text));
        return r('226 Done');
      }
      case 'RETR': case 'DELE': case 'RNFR': case 'RNTO': case 'MKD': case 'RMD': case 'APPE': case 'STOU': case 'SITE':
        return r('550 Not available: the drop box is write-only; fetch released files over HTTPS (/legacy/v1/objects/<sha256>)');
      default: return r('502 Command not implemented');
    }
  }

  return { greeting, handle };
}
