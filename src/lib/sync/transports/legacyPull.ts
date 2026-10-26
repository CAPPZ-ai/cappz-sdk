/**
 * COPE node crystallized.
 * Node ID: v15-09-00-legacy-pull
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The CAPPZ FTP client: a DMZ node pulls files from partner FTPS/SFTP
 * servers into its quarantine (quarantine.ts), and internal clients fetch the
 * released files from the node. The node runs the system curl (FTPS and, when
 * curl is built with libssh, SFTP) — no new dependency. This file only plans:
 * which files are new, and the exact curl arguments.
 *
 * Partner credentials are third-party secrets: they stay in the node's
 * environment (named by userEnv/passEnv), reach curl on stdin (`--config -`),
 * never in argv (visible in the process list) and never in a TX — records
 * name the remote without its userinfo. Plain FTP is refused unless the
 * source sets allowPlainFtp (credentials and files would cross in clear).
 */

export interface LegacyPullSource {
  id: string;
  /** Directory URL ending in '/': ftps://host/outbox/ or sftp://host/outbox/ (ftp:// only with allowPlainFtp). */
  url: string;
  userEnv?: string;
  passEnv?: string;
  /** Suffix filter, e.g. '.xml' (case-insensitive). */
  suffix?: string;
  intervalSec?: number;
  allowPlainFtp?: boolean;
  maxBytes?: number;
}

export type SourceCheck = { ok: true; scheme: 'ftps' | 'sftp' | 'ftp' } | { ok: false; reason: string };

export function checkSource(s: LegacyPullSource): SourceCheck {
  let u: URL;
  try { u = new URL(s.url); } catch { return { ok: false, reason: 'url is not a URL' }; }
  const scheme = u.protocol.replace(':', '');
  if (u.username || u.password) return { ok: false, reason: 'credentials belong in userEnv/passEnv, never in the URL' };
  if (!s.url.endsWith('/')) return { ok: false, reason: 'url must name a directory (end with /)' };
  if (scheme === 'ftp' && !s.allowPlainFtp) return { ok: false, reason: 'plain FTP sends credentials in clear; use ftps:// or sftp://, or set allowPlainFtp' };
  if (scheme !== 'ftps' && scheme !== 'sftp' && scheme !== 'ftp') return { ok: false, reason: `${scheme} is not a pull scheme (ftps, sftp)` };
  return { ok: true, scheme };
}

/** The remote as it may be recorded: no userinfo, no query. */
export function recordableRemote(url: string): string {
  try { const u = new URL(url); u.username = ''; u.password = ''; u.search = ''; return u.href; } catch { return '(unparseable)'; }
}

const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * curl invocation for listing the directory or fetching one file. Returns argv
 * and the stdin config text (which carries the credentials).
 */
export function curlPlan(s: LegacyPullSource, op: 'list' | 'get', env: Record<string, string | undefined>, name?: string): { args: string[]; stdin: string } {
  const c = checkSource(s);
  if (c.ok === false) throw new Error((c as { reason: string }).reason);
  if (op === 'get' && (!name || name.includes('/') || name === '.' || name === '..')) throw new Error('file name must be a plain name in the directory');
  const lines: string[] = [];
  const user = s.userEnv ? env[s.userEnv] : undefined;
  const pass = s.passEnv ? env[s.passEnv] : undefined;
  if (user) lines.push(`user = ${quote(pass !== undefined ? `${user}:${pass}` : user)}`);
  const target = op === 'list' ? s.url : s.url + encodeURIComponent(name!);
  lines.push(`url = ${quote(target)}`);
  const args = ['--config', '-', '--silent', '--show-error', '--fail', '--max-time', '300', '--proto', c.scheme === 'ftp' ? '=ftp' : `=${c.scheme}`];
  if (c.scheme === 'ftps') args.push('--ssl-reqd');
  if (op === 'list') args.push('--list-only');
  if (op === 'get' && s.maxBytes) args.push('--max-filesize', String(s.maxBytes));
  return { args, stdin: lines.join('\n') + '\n' };
}

/** Names from a `--list-only` listing (FTP NLST or SFTP names), without directories and dot entries. */
export function parseListing(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== '.' && l !== '..' && !l.endsWith('/') && !l.includes('/'));
}

/** Files to fetch this round: listed, matching the suffix, not seen before (seen = name|size or name). */
export function planPull(s: LegacyPullSource, listed: readonly string[], seen: ReadonlySet<string>): string[] {
  const suffix = s.suffix?.toLowerCase();
  return listed.filter((n) => (!suffix || n.toLowerCase().endsWith(suffix)) && !seen.has(`${s.id}|${n}`));
}

export const seenKey = (s: LegacyPullSource, name: string) => `${s.id}|${name}`;
