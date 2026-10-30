/**
 * COPE node crystallized.
 * Node ID: v15-12-00-php-inventory
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Read a PHP application (source text, optionally nginx access logs and a
 * crontab) and answer: which routes exist, what each one touches, where it
 * goes in CAPPZ, in what order, and how big each port is. Pure function —
 * the same code runs in the CLI (packages/cappz-edge-node/tools/php-port.ts)
 * and in the browser tutorial (/tutorials/move-off-php); nothing is uploaded.
 *
 * Routes come from: plain .php files under the document root; Laravel
 * (Route::get), Slim / Lumen / Silex ($app->get), CodeIgniter 4 ($routes->get)
 * and Symfony (#[Route]) definitions; and paths seen in the access log that no
 * definition explains (reported as unmapped — usually a rewrite to a front
 * controller). Per route it detects tables read and written, sessions,
 * uploads, mail, outbound HTTP, secrets read from the environment, and
 * libraries that need a replacement. Detection is lexical: it reads code, it
 * does not run it, so the plan says "detected", never "proven".
 *
 * Order (waves), lowest risk and highest traffic first:
 *   1 read-only     no writes, session, upload, mail or secret → edge-node handler
 *   2 writes        tables written → the port emits TXs (wallet data); a table
 *                   moves whole once its last legacy writer is ported
 *   3 stateful      sessions → KeyZ-signed requests / passkeys; uploads → DMZ
 *                   quarantine; mail and outbound HTTP without secrets → edge node
 *   4 secrets-last  reads a third-party secret → hosted only where the secret forces it
 */
import { callIndex } from '../text/textScan.ts';

export interface PhpSource { path: string; text: string }

export type Framework = 'plain' | 'laravel' | 'slim' | 'codeigniter' | 'symfony' | 'wordpress';
export type Destination = 'edge-node' | 'hosted-secrets-last';

export interface RouteUses {
  reads: string[];
  writes: string[];
  session: boolean;
  uploads: boolean;
  mail: boolean;
  outboundHttp: boolean;
  secrets: string[];
  libraries: string[];
  output: 'json' | 'html' | 'redirect' | 'file' | 'unknown';
  includes: string[];
}

export interface InventoryRoute {
  key: string;
  method: string;
  path: string;
  source: string;
  line: number;
  definedBy: 'file' | Framework;
  uses: RouteUses;
  lines: number;
  hits: number;
  errorRate: number;
  wave: 1 | 2 | 3 | 4;
  destination: Destination;
  effort: 'S' | 'M' | 'L';
  steps: string[];
}

export interface TableUse { table: string; readers: string[]; writers: string[]; movesAfter: string }
export interface CronEntry { schedule: string; command: string; script?: string; becomes: string }

export interface Inventory {
  framework: Framework[];
  files: number;
  phpLines: number;
  routes: InventoryRoute[];
  tables: TableUse[];
  cron: CronEntry[];
  unmapped: Array<{ path: string; hits: number }>;
  libraries: Array<{ name: string; routes: number; replacement: string }>;
  totals: { routes: number; byWave: Record<1 | 2 | 3 | 4, number>; hitsCovered: number; hits: number };
  warnings: string[];
}

/** PHP library or extension → what replaces it in a TypeScript handler. */
export const LIBRARY_MAP: Record<string, { re: RegExp; replacement: string; large?: boolean }> = {
  'password_hash/verify': { re: /\bpassword_(?:hash|verify)\s*\(/, replacement: 'keep verifying existing $2y$ hashes with a bcrypt library during the move; new sign-ins use passkeys / KeyZ keys' },
  'hash_hmac': { re: /\bhash_hmac\s*\(/, replacement: 'WebCrypto HMAC (crypto.subtle.sign)' },
  'openssl_*': { re: /\bopenssl_\w+\s*\(/, replacement: 'WebCrypto; signature checks move to KeyZ Gate' },
  'sodium_*': { re: /\bsodium_\w+\s*\(/, replacement: 'WebCrypto Ed25519 / X25519' },
  'curl': { re: /\bcurl_(?:init|exec)\s*\(|GuzzleHttp/, replacement: 'fetch()' },
  'PDO/mysqli': { re: /\bnew\s+PDO\s*\(|\bmysqli_\w+\s*\(|new\s+mysqli\s*\(/, replacement: 'wallet TXs + replayed views (data lives in wallets); a read-only database adapter only while a table is moving' },
  'unserialize': { re: /\bunserialize\s*\(/, replacement: 'JSON.parse (also removes a PHP object-injection risk)' },
  'gd/imagick': { re: /\bimagecreate\w*\s*\(|\bnew\s+Imagick\b|Intervention\\Image/, replacement: 'an image library (sharp or a WebAssembly build); media decoding stays on-device where it can', large: true },
  'pdf': { re: /\bnew\s+(?:TCPDF|FPDF|Dompdf|Mpdf)\b|Dompdf\\|Mpdf\\/, replacement: 'pdf-lib, or render HTML and print', large: true },
  'spreadsheet': { re: /PhpOffice\\PhpSpreadsheet|PHPExcel/, replacement: 'SheetJS / exceljs', large: true },
  'redis/memcached': { re: /\bnew\s+(?:Redis|Memcached)\b|Predis\\/, replacement: 'in-process cache, or wallet state for anything durable' },
  'templating': { re: /->render\s*\(|\bview\s*\(|Twig\\|\$smarty|\{\{\s*\$/, replacement: 'React pages, or a handler that returns HTML' },
};

const SQL_READ = /\b(?:FROM|JOIN)\s+[`"[]?([A-Za-z_][\w]*)[`"\]]?/gi;
const SQL_WRITE = /\b(?:INSERT\s+(?:IGNORE\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+[`"[]?([A-Za-z_][\w]*)[`"\]]?/gi;
const ORM_READ = /DB::table\(\s*['"](\w+)['"]\s*\)(?:(?!->(?:insert|update|delete|upsert)\b)[^;])*;/g;
const ORM_WRITE = /DB::table\(\s*['"](\w+)['"]\s*\)[^;]*->(?:insert|update|delete|upsert|increment|decrement)\b/g;
const SQL_WORDS = new Set(['select', 'where', 'set', 'values', 'dual', 'information_schema', 'the', 'a', 'an', 'and', 'or', 'as', 'on', 'if', 'not', 'exists', 'into']);
const SECRET_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|DSN|CREDENTIAL|PRIVATE)/i;

function analyse(text: string): RouteUses {
  const reads = new Set<string>(); const writes = new Set<string>();
  for (const m of text.matchAll(SQL_WRITE)) if (!SQL_WORDS.has(m[1].toLowerCase())) writes.add(m[1].toLowerCase());
  for (const m of text.matchAll(ORM_WRITE)) writes.add(m[1].toLowerCase());
  for (const m of text.matchAll(SQL_READ)) if (!SQL_WORDS.has(m[1].toLowerCase())) reads.add(m[1].toLowerCase());
  for (const m of text.matchAll(ORM_READ)) reads.add(m[1].toLowerCase());
  for (const m of text.matchAll(/\b(\w+)::(?:where|find|all|first|get|paginate)\s*\(/g)) if (/^[A-Z]/.test(m[1]) && !['DB', 'Route', 'Auth', 'Session', 'Cache', 'Request', 'Str', 'Arr'].includes(m[1])) reads.add(`${m[1].toLowerCase()} (model)`);
  for (const m of text.matchAll(/\b(\w+)::(?:create|updateOrCreate|destroy|insert)\s*\(|\$\w+->(?:save|delete|update)\s*\(\s*\)/g)) if (m[1] && /^[A-Z]/.test(m[1])) writes.add(`${m[1].toLowerCase()} (model)`);
  // Files used as storage (a JSON or CSV "database", an upload directory): local paths, not URLs.
  if (/\bfile_put_contents\s*\(|\bfwrite\s*\(|\bfputcsv\s*\(|\bfopen\s*\([^)]*,\s*['"][wax]/.test(text)) writes.add('files');
  if (/\bfile_get_contents\s*\(\s*(?!['"]https?:)|\bfopen\s*\([^)]*,\s*['"]r|\bfgetcsv\s*\(|\bfile\s*\(\s*__DIR__/.test(text)) reads.add('files');
  const secrets = new Set<string>();
  for (const m of text.matchAll(/\b(?:getenv|env)\s*\(\s*['"](\w+)['"]|\$_(?:ENV|SERVER)\s*\[\s*['"](\w+)['"]\s*\]|\bdefine\s*\(\s*['"](\w+)['"]/g)) { const n = m[1] ?? m[2] ?? m[3]; if (n && SECRET_NAME.test(n) && !/^(?:HTTP_|REQUEST_|SCRIPT_|PHP_AUTH_DIGEST$)/.test(n)) secrets.add(n); }
  const libraries = Object.entries(LIBRARY_MAP).filter(([, l]) => l.re.test(text)).map(([n]) => n);
  const includes = Array.from(text.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+\.php)['"]/g), (m) => m[1].replace(/^\//, ''));
  const output: RouteUses['output'] = /header\s*\(\s*['"]Location:|redirect\s*\(|->redirect\(|return\s+redirect/i.test(text) ? 'redirect'
    : /json_encode\s*\(|application\/json|response\(\)->json|->json\s*\(|JsonResponse/.test(text) ? 'json'
      : /\breadfile\s*\(|fpassthru\s*\(|->download\s*\(|BinaryFileResponse/.test(text) ? 'file'
        : /<html|<div|<\?=|\becho\b|\bprint\b|->render\s*\(|\bview\s*\(/i.test(text) ? 'html' : 'unknown';
  return {
    reads: [...reads].filter((t) => !writes.has(t)).sort(), writes: [...writes].sort(),
    session: /\$_SESSION\b|session_start\s*\(|Session::|session\s*\(\s*\)|->session\s*\(/.test(text),
    uploads: /\$_FILES\b|move_uploaded_file\s*\(|->file\s*\(\s*['"]|UploadedFile/.test(text),
    mail: /\bmail\s*\(|PHPMailer|Swift_|Mail::|Symfony\\Component\\Mailer|wp_mail\s*\(/.test(text),
    outboundHttp: /\bcurl_(?:init|exec)\s*\(|file_get_contents\s*\(\s*['"]https?:|GuzzleHttp|Http::(?:get|post)|wp_remote_/.test(text),
    secrets: [...secrets].sort(), libraries, output, includes,
  };
}

/** The block a route's handler occupies: a named method, or the closure after a route definition. */
function blockAt(text: string, start: number): string {
  const open = text.indexOf('{', start);
  if (open < 0) return text.slice(start, start + 2000);
  let depth = 0; let i = open; let inStr: string | null = null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === '\\') i++; else if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) break;
  }
  return text.slice(start, i + 1);
}

const lineOf = (text: string, idx: number) => text.slice(0, idx).split('\n').length;
const normPath = (p: string) => '/' + p.replace(/^\/+/, '').replace(/\{(\w+)(?::[^}]*)?\??\}/g, ':$1').replace(/\/+$/, '');

function frameworkOf(files: PhpSource[]): Framework[] {
  const has = (re: RegExp) => files.some((f) => re.test(f.path));
  const any = (re: RegExp) => files.some((f) => re.test(f.text));
  const out: Framework[] = [];
  if (has(/(?:^|\/)artisan$/) || has(/(?:^|\/)routes\/(?:web|api)\.php$/)) out.push('laravel');
  if (any(/Slim\\(?:App|Factory\\AppFactory)|Laravel\\Lumen|Silex\\Application/)) out.push('slim');
  if (has(/(?:^|\/)app\/Config\/Routes\.php$/)) out.push('codeigniter');
  if (any(/#\[Route\(/) || any(/@Route\(/)) out.push('symfony');
  if (has(/(?:^|\/)wp-config\.php$/) || has(/(?:^|\/)wp-includes\//)) out.push('wordpress');
  if (!out.length) out.push('plain');
  return out;
}

interface Def { method: string; path: string; source: string; line: number; definedBy: InventoryRoute['definedBy']; text: string }

function frameworkRoutes(files: PhpSource[]): Def[] {
  const defs: Def[] = [];
  const byClass = new Map<string, PhpSource>();
  for (const f of files) { const m = /\bclass\s+(\w+)/.exec(f.text); if (m) byClass.set(m[1], f); }
  const methodText = (cls: string, method: string): { src: string; line: number; text: string } | null => {
    const f = byClass.get(cls); if (!f) return null;
    const at = callIndex(f.text, method, 'function'); if (at < 0) return { src: f.path, line: 1, text: f.text };
    return { src: `${f.path}#${method}`, line: lineOf(f.text, at), text: blockAt(f.text, at) };
  };
  const ROUTE = /(?:Route::|\$app->|\$router->|\$routes->|\$group->)(get|post|put|patch|delete|any|options)\s*\(\s*['"]([^'"]*)['"]\s*,\s*/gi;
  for (const f of files) {
    if (!/Route::|\$app->|\$router->|\$routes->|\$group->|#\[Route\(/.test(f.text)) continue;
    for (const m of f.text.matchAll(ROUTE)) {
      const after = f.text.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
      const methods = m[1].toLowerCase() === 'any' ? ['GET', 'POST'] : [m[1].toUpperCase()];
      let target: { src: string; line: number; text: string } | null = null;
      const arr = /^\[\s*(?:\\?[\w\\]*\\)?(\w+)::class\s*,\s*['"](\w+)['"]\s*\]/.exec(after);
      const at = /^['"](?:[\w\\]*\\)?(\w+)@(\w+)['"]/.exec(after);
      const ci = /^['"](\w+)::(\w+)['"]/.exec(after);
      const c = arr ?? at ?? ci;
      if (c) target = methodText(c[1], c[2]);
      if (!target && /^(?:function|fn|static\s+function)\b/.test(after)) target = { src: `${f.path}:${lineOf(f.text, m.index!)}`, line: lineOf(f.text, m.index!), text: blockAt(f.text, m.index! + m[0].length) };
      for (const method of methods) defs.push({ method, path: normPath(m[2]), source: target?.src ?? f.path, line: target?.line ?? lineOf(f.text, m.index!), definedBy: f.path.includes('routes/') || /Route::/.test(m[0]) ? 'laravel' : /\$routes->/.test(m[0]) ? 'codeigniter' : 'slim', text: target?.text ?? '' });
    }
    for (const m of f.text.matchAll(/#\[Route\(\s*['"]([^'"]+)['"]([^\]]*)\]\s*(?:public\s+)?function\s+(\w+)/g)) {
      const methods = /methods\s*:\s*\[([^\]]*)\]/.exec(m[2])?.[1].match(/\w+/g)?.map((x) => x.toUpperCase()) ?? ['GET'];
      for (const method of methods) defs.push({ method, path: normPath(m[1]), source: `${f.path}#${m[3]}`, line: lineOf(f.text, m.index!), definedBy: 'symfony', text: blockAt(f.text, m.index!) });
    }
  }
  return defs;
}

const LIB_DIRS = /(?:^|\/)(?:vendor|node_modules|tests?|includes?|inc|lib|libs|src|app|config|bootstrap|storage|database|resources|routes|cache|tmp|wp-includes|wp-admin)\//;

function plainRoutes(files: PhpSource[], included: Set<string>, docroot?: string): Def[] {
  const root = docroot ?? (files.some((f) => /^public\//.test(f.path)) ? 'public/' : '');
  const defs: Def[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.php') || !f.path.startsWith(root)) continue;
    const rel = f.path.slice(root.length);
    if (LIB_DIRS.test(rel) || included.has(rel) || included.has(f.path)) continue;
    if (/^\s*<\?php\s+(?:namespace|class|interface|trait|return\s*\[)/.test(f.text) && !/\becho\b|header\s*\(/.test(f.text)) continue;
    const path = '/' + rel.replace(/(?:^|\/)index\.php$/, '');
    const methods = new Set<string>(['GET']);
    if (/\$_POST\b|REQUEST_METHOD['"]\]\s*===?\s*['"]POST|php:\/\/input/.test(f.text)) methods.add('POST');
    if (/['"](?:PUT|PATCH|DELETE)['"]/.test(f.text) && /REQUEST_METHOD/.test(f.text)) for (const m of f.text.match(/['"](PUT|PATCH|DELETE)['"]/g) ?? []) methods.add(m.replace(/['"]/g, ''));
    // A file that branches on the method: the POST branch is the POST route, the rest is GET.
    const branch = /if\s*\(\s*\$_SERVER\s*\[\s*['"]REQUEST_METHOD['"]\s*\]\s*===?\s*['"](POST|PUT|PATCH|DELETE)['"]\s*\)/.exec(f.text);
    const block = branch ? blockAt(f.text, branch.index) : '';
    for (const method of methods) {
      const text = !block ? f.text : method === branch![1] ? block + '\n' + (f.text.match(/\b(?:require|include)(?:_once)?\b[^;]*;/g) ?? []).join('\n') : method === 'GET' ? f.text.replace(block, '') : f.text;
      defs.push({ method, path: path === '/' ? '/' : path.replace(/\/$/, ''), source: f.path, line: branch && method === branch[1] ? lineOf(f.text, branch.index) : 1, definedBy: 'file', text });
    }
  }
  return defs;
}

/** nginx/Apache combined log: hits and error rates per path (query stripped). */
export function parseAccessLog(text: string): Map<string, { hits: number; errors: number }> {
  const out = new Map<string, { hits: number; errors: number }>();
  for (const m of text.matchAll(/"([A-Z]+) ([^ "?]+)(?:\?[^ "]*)? HTTP\/[\d.]+" (\d{3})/g)) {
    const k = `${m[1]} ${m[2].length > 1 ? m[2].replace(/\/$/, '') : m[2]}`;
    const e = out.get(k) ?? { hits: 0, errors: 0 };
    e.hits++; if (m[3].startsWith('5')) e.errors++;
    out.set(k, e);
  }
  return out;
}

function matches(pattern: string, path: string): boolean {
  const a = pattern.split('/').filter(Boolean); const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((s, i) => s.startsWith(':') || s === b[i]);
}

export function parseCrontab(text: string): CronEntry[] {
  const out: CronEntry[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const m = /^((?:@\w+)|(?:\S+\s+\S+\s+\S+\s+\S+\s+\S+))\s+(.*)$/.exec(t); if (!m) continue;
    if (!/\bphp\b|\.php\b|artisan/.test(m[2])) continue;
    const script = /(\S+\.php|artisan\s+[\w:-]+)/.exec(m[2])?.[1];
    out.push({ schedule: m[1], command: m[2], script, becomes: 'a BPMN timer on the edge node (jobs.ts; the job signs every TX it writes)' });
  }
  return out;
}

export function inventoryPhpApp(input: { files: PhpSource[]; accessLog?: string; crontab?: string; docroot?: string }): Inventory {
  const php = input.files.filter((f) => f.path.endsWith('.php'));
  const fw = frameworkOf(php);
  const warnings: string[] = [];
  if (fw.includes('wordpress')) warnings.push('WordPress: port the REST routes and custom pages you use; themes and plugins are large — keep WordPress behind the route host until the pages you need are ported.');
  const byPathAll = new Map(php.map((f) => [f.path, f]));
  /** `require __DIR__ . '/../lib/x.php'` from public/api/a.php → lib/x.php (or the closest file with that tail). */
  const resolveInclude = (from: string, inc: string): PhpSource | undefined => {
    const parts = from.split('#')[0].split(':')[0].split('/').slice(0, -1);
    for (const seg of inc.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
    const tail = inc.replace(/^(?:\.{1,2}\/)+/, '').replace(/^\//, '');
    return byPathAll.get(parts.join('/')) ?? php.find((x) => x.path === tail || x.path.endsWith(`/${tail}`));
  };
  const included = new Set(php.flatMap((f) => analyse(f.text).includes.map((i) => resolveInclude(f.path, i)?.path).filter((p): p is string => !!p)));
  const defs = [...frameworkRoutes(php), ...(fw.includes('plain') || fw.includes('wordpress') ? plainRoutes(php, included, input.docroot) : [])];
  const seen = new Set<string>(); const unique = defs.filter((d) => { const k = `${d.method} ${d.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const log = input.accessLog ? parseAccessLog(input.accessLog) : new Map<string, { hits: number; errors: number }>();
  const claimed = new Set<string>();

  const routes: InventoryRoute[] = unique.map((d) => {
    const key = `${d.method} ${d.path}`;
    // Includes add their uses: a route that includes db.php writes what db.php writes.
    let text = d.text;
    for (const inc of analyse(d.text).includes) {
      const f = resolveInclude(d.source, inc); if (!f) continue;
      // A library of functions contributes only the functions this route calls; other includes count whole.
      const fns = Array.from(f.text.matchAll(/\bfunction\s+(\w+)\s*\(/g));
      text += '\n' + (fns.length ? fns.filter((m) => callIndex(d.text, m[1]) >= 0).map((m) => blockAt(f.text, m.index!)).join('\n') : f.text);
    }
    const uses = analyse(text);
    let hits = 0; let errors = 0;
    for (const [k, v] of log) { const [m, p] = [k.slice(0, k.indexOf(' ')), k.slice(k.indexOf(' ') + 1)]; if ((m === d.method || (m === 'HEAD' && d.method === 'GET')) && (p === d.path || matches(d.path, p) || p === `${d.path}.php`)) { hits += v.hits; errors += v.errors; claimed.add(k); } }
    const lines = d.text.split('\n').length;
    const wave: InventoryRoute['wave'] = uses.secrets.length ? 4 : uses.session || uses.uploads || uses.mail || uses.outboundHttp ? 3 : uses.writes.length ? 2 : 1;
    const large = uses.libraries.some((l) => LIBRARY_MAP[l]?.large);
    const effort: InventoryRoute['effort'] = large || lines > 300 || uses.includes.length > 4 ? 'L' : lines > 80 || uses.writes.length + uses.reads.length > 3 || wave >= 3 ? 'M' : 'S';
    const steps: string[] = [];
    if (uses.reads.length) steps.push(`read ${uses.reads.join(', ')} from wallet views (import the tables once; a read-only adapter only while they move)`);
    if (uses.writes.length) steps.push(`emit TXs for writes to ${uses.writes.join(', ')} (ctx.emit; dry-run in shadow)`);
    if (uses.session) steps.push('replace the PHP session with KeyZ-signed requests or passkeys (the route host passes the verdict as ctx.verdict)');
    if (uses.uploads) steps.push('take uploads through the DMZ quarantine (receipts, scan, release)');
    if (uses.mail) steps.push(uses.secrets.length ? 'send mail through the hosted mail function (secrets-last)' : 'send mail from the edge node');
    if (uses.outboundHttp) steps.push('fetch() for outbound calls; in shadow mode skip them (ctx.mode === "shadow")');
    for (const l of uses.libraries) steps.push(`${l} → ${LIBRARY_MAP[l].replacement}`);
    if (uses.secrets.length) steps.push(`secrets ${uses.secrets.join(', ')}: keep the call that needs them hosted (secrets-last); move the rest`);
    steps.push(`compare as ${uses.output === 'json' ? 'JSON (ignore volatile paths such as timestamps)' : uses.output === 'html' ? 'normalised HTML (blank CSRF tokens)' : uses.output}`);
    return { key, method: d.method, path: d.path, source: d.source, line: d.line, definedBy: d.definedBy, uses, lines, hits, errorRate: hits ? errors / hits : 0, wave, destination: wave === 4 ? 'hosted-secrets-last' : 'edge-node', effort, steps };
  });
  routes.sort((a, b) => a.wave - b.wave || b.hits - a.hits || ({ S: 0, M: 1, L: 2 }[a.effort] - { S: 0, M: 1, L: 2 }[b.effort]) || a.key.localeCompare(b.key));

  const tables = new Map<string, TableUse>();
  for (const r of routes) {
    for (const t of r.uses.reads) { const u = tables.get(t) ?? { table: t, readers: [], writers: [], movesAfter: '' }; u.readers.push(r.key); tables.set(t, u); }
    for (const t of r.uses.writes) { const u = tables.get(t) ?? { table: t, readers: [], writers: [], movesAfter: '' }; u.writers.push(r.key); tables.set(t, u); }
  }
  for (const u of tables.values()) u.movesAfter = u.writers.length ? `its last legacy writer is cut over (${u.writers.join(', ')})` : 'an import of the current rows (read-only here)';

  const unmapped = [...log].filter(([k]) => !claimed.has(k) && !/\.(?:css|js|png|jpe?g|gif|svg|ico|woff2?|map|txt|webp)$/i.test(k)).map(([k, v]) => ({ path: k, hits: v.hits })).sort((a, b) => b.hits - a.hits).slice(0, 25);
  if (unmapped.length) warnings.push(`${unmapped.length} paths in the access log match no route definition — usually a rewrite to a front controller (index.php); add them as routes or check the rewrite rules.`);
  const libCount = new Map<string, number>();
  for (const r of routes) for (const l of r.uses.libraries) libCount.set(l, (libCount.get(l) ?? 0) + 1);
  const hits = [...log.values()].reduce((a, v) => a + v.hits, 0);
  const byWave = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<1 | 2 | 3 | 4, number>;
  for (const r of routes) byWave[r.wave]++;
  if (!routes.length) warnings.push('No routes found: point --src at the application root (where public/ or routes/ is).');
  return {
    framework: fw, files: php.length, phpLines: php.reduce((a, f) => a + f.text.split('\n').length, 0), routes, tables: [...tables.values()].sort((a, b) => a.table.localeCompare(b.table)),
    cron: input.crontab ? parseCrontab(input.crontab) : [], unmapped,
    libraries: [...libCount].map(([name, n]) => ({ name, routes: n, replacement: LIBRARY_MAP[name].replacement })).sort((a, b) => b.routes - a.routes),
    totals: { routes: routes.length, byWave, hitsCovered: routes.reduce((a, r) => a + r.hits, 0), hits }, warnings,
  };
}

const WAVE_TITLE = { 1: 'Wave 1 · read-only', 2: 'Wave 2 · writes', 3: 'Wave 3 · sessions, uploads, mail, outbound calls', 4: 'Wave 4 · secrets-last' } as const;

/** The port plan as Markdown (PLAN.md in the scaffold). */
export function planMarkdown(inv: Inventory): string {
  const L: string[] = [`# Port plan: PHP → CAPPZ`, '', `Framework: ${inv.framework.join(', ')} · ${inv.files} PHP files, ${inv.phpLines.toLocaleString('en-US')} lines · ${inv.totals.routes} routes${inv.totals.hits ? ` · ${inv.totals.hitsCovered.toLocaleString('en-US')} of ${inv.totals.hits.toLocaleString('en-US')} logged requests covered` : ''}`, '', 'Detection is lexical (the code is read, not run). Every route starts in legacy mode; a written port is shadowed automatically and cut over only on its report (`edge.route.cutover`).', ''];
  for (const w of [1, 2, 3, 4] as const) {
    const rs = inv.routes.filter((r) => r.wave === w); if (!rs.length) continue;
    L.push(`## ${WAVE_TITLE[w]} (${rs.length})`, '', '| Route | Source | Hits | Effort | Uses |', '|---|---|---|---|---|');
    for (const r of rs) L.push(`| \`${r.key}\` | ${r.source}:${r.line} | ${r.hits.toLocaleString('en-US')} | ${r.effort} | ${[r.uses.reads.length ? `reads ${r.uses.reads.join(', ')}` : '', r.uses.writes.length ? `writes ${r.uses.writes.join(', ')}` : '', r.uses.session ? 'session' : '', r.uses.uploads ? 'uploads' : '', r.uses.mail ? 'mail' : '', r.uses.outboundHttp ? 'outbound HTTP' : '', r.uses.secrets.length ? `secrets ${r.uses.secrets.join(', ')}` : '', r.uses.output].filter(Boolean).join(' · ')} |`);
    L.push('');
  }
  if (inv.tables.length) { L.push('## Data: tables and file stores (each moves whole: writers, readers, when)', '', '| Data | Readers | Writers | Moves after |', '|---|---|---|---|'); for (const t of inv.tables) L.push(`| ${t.table} | ${t.readers.length} | ${t.writers.length} | ${t.movesAfter} |`); L.push(''); }
  if (inv.cron.length) { L.push('## Cron', ''); for (const c of inv.cron) L.push(`- \`${c.schedule}\` ${c.command} → ${c.becomes}`); L.push(''); }
  if (inv.libraries.length) { L.push('## Libraries to replace', ''); for (const l of inv.libraries) L.push(`- **${l.name}** (${l.routes} routes) → ${l.replacement}`); L.push(''); }
  if (inv.unmapped.length) { L.push('## Logged paths with no route definition', ''); for (const u of inv.unmapped) L.push(`- \`${u.path}\` (${u.hits})`); L.push(''); }
  if (inv.warnings.length) { L.push('## Warnings', ''); for (const w of inv.warnings) L.push(`- ${w}`); L.push(''); }
  L.push('## Done when', '', 'Every route is cut over, every table has moved, cron runs as timers — then stop php-fpm. Public HTTPS keeps its certificate on nginx/Caddy (or the node, with certbot files).');
  return L.join('\n');
}

/** routes.ts for the scaffold: every route defined, every handler notPorted() until it is written. */
export function scaffoldRoutes(inv: Inventory, importFrom = '@cappz/sdk/port'): string {
  const L = [`// Generated by php-port inventory. Each handler is notPorted until you write it: such routes stay on PHP`, `// (nginx does not even send them to the route host). A written handler is shadowed automatically`, `// (CAPPZ_ROUTES_DEFAULT_MODE=shadow) and served only after edge.route.cutover.`, `import { defineRoute, notPorted, type PortedRoute } from '${importFrom}';`, '', 'export const routes: PortedRoute[] = ['];
  for (const r of inv.routes) {
    L.push(`  // ${r.key} — ${r.source}:${r.line} · wave ${r.wave} · effort ${r.effort}${r.hits ? ` · ${r.hits} hits` : ''}`);
    for (const s of r.steps) L.push(`  //   - ${s}`);
    const compare = r.uses.output === 'json' ? `, compare: { ignoreJsonPaths: [] }` : r.uses.output === 'html' ? `, compare: { ignoreTemplates: ['name="_token" value="*"', 'name="csrf*" value="*"'] }` : '';
    L.push(`  defineRoute({ method: '${r.method}', path: '${r.path}', legacySource: '${r.source.replace(/'/g, "\\'")}'${compare}, handler: notPorted }),`);
  }
  L.push('];', '');
  return L.join('\n');
}

/** nginx: PHP stays where it is; only ported routes go through the route host (generated include). */
export function nginxSnippet(o: { hostPort?: number; legacyPort?: number; docroot?: string } = {}): string {
  const root = o.docroot ?? '/var/www/app/public';
  return [
    '# 1 · an internal listener for PHP — the route host forwards legacy and shadowed requests here',
    `server { listen 127.0.0.1:${o.legacyPort ?? 8080}; root ${root}; index index.php;`,
    '  location / { try_files $uri $uri/ /index.php?$query_string; }',
    '  location ~ \\.php$ { include fastcgi_params; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; fastcgi_pass unix:/run/php/php-fpm.sock; } }',
    '',
    '# 2 · the route host',
    `upstream cappz_routes { server 127.0.0.1:${o.hostPort ?? 41450}; keepalive 64; }`,
    '',
    '# 3 · in your public server block, above the PHP location: only ported routes go to the host,',
    '#     everything else reaches php-fpm exactly as today (no extra hop).',
    '#       include /etc/nginx/cappz-routes.conf;',
    '#     Write it after each port:  php-port.ts nginx > /etc/nginx/cappz-routes.conf && nginx -s reload',
    '#     When every route is ported:  location / { proxy_pass http://cappz_routes; … } and stop php-fpm.',
  ].join('\n');
}
