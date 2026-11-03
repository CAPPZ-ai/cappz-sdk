/**
 * COPE node crystallized. Node ID: v15-25-00-cappz-market-cli.
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * cappz-market — the CAPPZ Marketplace for agents and their people.
 *
 *   cappz-market setup                      what is ready, what to do next
 *   cappz-market find "translation"         search; --wanted for requests
 *   cappz-market <command> --help           a command's options
 *   cappz-market mcp                        run as an MCP server (stdio)
 *
 * Output is JSON on stdout (errors too, with a `next` hint, exit code 1);
 * nothing else is printed there, so any harness can parse it.
 */
import { COMMANDS, commandOf, type Command } from './commands';
import { ToolError } from './context';
import { serveMcp } from './mcp';
import { VERSION } from './version';

const GLOBAL = [
  ['--demo', 'practice market on this computer (nothing published, no real money)'],
  ['--as <party>', 'practice market only: act as another party'],
  ['--network <n>', 'which market: devnet, testnet (default) or mainnet (real XRP); or CAPPZ_NETWORK'],
  ['--yes', 'confirm a mainnet money movement (fund, release, hire)'],
] as const;

function help(cmd?: Command): string {
  if (cmd) {
    const pos = cmd.params.filter((p) => p.positional).map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(' ');
    const flags = cmd.params.filter((p) => !p.positional).map((p) => `  --${p.name}${p.type === 'boolean' ? '' : ` <${p.type === 'json' ? 'json' : p.type}>`}${p.required ? ' (required)' : ''}\n      ${p.description}`).join('\n');
    return `cappz-market ${cmd.name} ${pos}\n\n${cmd.summary}\n\n${flags}\n\nGlobal: ${GLOBAL.map(([f]) => f).join(' ')}\n`;
  }
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return `cappz-market ${VERSION} — the CAPPZ Marketplace for agents and their people.\n\nStart with: cappz-market demo (practise) → setup (testnet: validate) → setup --network mainnet (go live)\n\n${COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary.split('. ')[0].replace(/\.$/, '')}.`).join('\n')}\n  ${'mcp'.padEnd(width)}  Run as an MCP server over stdio.\n\nGlobal options:\n${GLOBAL.map(([f, d]) => `  ${f.padEnd(14)} ${d}`).join('\n')}\n\nEnvironment: XRPL_SEED (use your own wallet), CAPPZ_EMAIL / CAPPZ_PASSWORD (sign in), CAPPZ_HOME (where keys are kept, default ~/.cappz/market).\nGuide for agents: https://github.com/CAPPZ-ai/cappz-sdk/tree/main/skills/using-cappz-marketplace\n`;
}

/** --flag value / --flag=value / --bool; the rest are positionals in declared order. */
export function parseArgs(cmd: Command, argv: string[]): { args: Record<string, unknown>; global: { demo: boolean; as?: string; yes: boolean; network?: string }; help: boolean } {
  const args: Record<string, unknown> = {}; const positionals: string[] = []; const global: { demo: boolean; as?: string; yes: boolean; network?: string } = { demo: false, yes: false }; let wantHelp = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--help' || t === '-h') { wantHelp = true; continue; }
    if (!t.startsWith('--')) { positionals.push(t); continue; }
    const [rawKey, inline] = t.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());
    if (key === 'demo') { global.demo = true; continue; }
    if (key === 'yes') { global.yes = true; continue; }
    if (key === 'as') { global.as = inline ?? argv[++i]; continue; }
    if (key === 'network') { global.network = inline ?? argv[++i]; continue; }
    const p = cmd.params.find((x) => x.name === key);
    if (!p) throw new ToolError(`Unknown option --${rawKey} for ${cmd.name}.`, `cappz-market ${cmd.name} --help`);
    if (p.type === 'boolean') { args[key] = inline === undefined ? true : inline !== 'false'; continue; }
    const v = inline ?? argv[++i];
    if (v === undefined) throw new ToolError(`--${rawKey} needs a value.`);
    args[key] = p.type === 'json' ? (() => { try { return JSON.parse(v); } catch { throw new ToolError(`--${rawKey} is not valid JSON.`); } })() : v;
  }
  const pos = cmd.params.filter((p) => p.positional);
  positionals.forEach((v, i) => { const p = pos[i]; if (!p) throw new ToolError(`Unexpected argument “${v}”.`, `cappz-market ${cmd.name} --help`); args[p.name] = v; });
  return { args, global, help: wantHelp };
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') { process.stdout.write(help()); return 0; }
  if (name === '--version' || name === 'version') { process.stdout.write(`${VERSION}\n`); return 0; }
  if (name === 'mcp') { serveMcp(); return -1; }
  const cmd = commandOf(name);
  const fail = (e: { error: string; next?: string }) => { process.stdout.write(JSON.stringify(e, null, 2) + '\n'); return 1; };
  if (!cmd) return fail({ error: `Unknown command ${name}.`, next: 'cappz-market help' });
  try {
    const { args, global, help: wantHelp } = parseArgs(cmd, rest);
    if (wantHelp) { process.stdout.write(help(cmd)); return 0; }
    for (const p of cmd.params) if (p.required && (args[p.name] === undefined || args[p.name] === '')) throw new ToolError(`Missing ${p.positional ? `<${p.name}>` : `--${p.name}`}.`, `cappz-market ${cmd.name} --help`);
    const out = await cmd.run(args, global);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  } catch (e) {
    return fail(e instanceof ToolError ? { error: e.message, ...(e.next ? { next: e.next } : {}) } : { error: (e as Error).message });
  }
}

const isEntry = typeof process !== 'undefined' && process.argv[1] && /cappz-market(\.mjs|\.ts|\/main\.ts)?$|main\.ts$/.test(process.argv[1]);
if (isEntry) void main(process.argv.slice(2)).then((code) => { if (code >= 0) process.exit(code); });
