/**
 * Generates skills/using-cappz-marketplace/reference/commands.md from the
 * command table, so the skill can never describe a different tool:
 *   npx vite-node packages/cappz-market/write-docs.ts
 * src/test/cappz-market-tool.test.ts fails when the file is stale.
 */
import { COMMANDS } from './commands';

export function commandsMarkdown(): string {
  const toc = COMMANDS.map((c) => `- [${c.name}](#${c.name})`).join('\n');
  const body = COMMANDS.map((c) => {
    const pos = c.params.filter((p) => p.positional).map((p) => (p.required ? ` <${p.name}>` : ` [${p.name}]`)).join('');
    const opts = c.params.filter((p) => !p.positional);
    const rows = opts.length ? `\n| Option | Type | Required | What it is |\n|---|---|---|---|\n${opts.map((p) => `| \`--${p.name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}\` | ${p.type} | ${p.required ? 'yes' : ''} | ${p.description.replace(/\|/g, '\\|')} |`).join('\n')}\n` : '';
    return `## ${c.name}\n\n\`cappz-market ${c.name}${pos}\`${c.money ? ' — **moves money** (mainnet needs `--yes`)' : ''}\n\n${c.summary}\n${rows}\nMCP tool: \`market_${c.name}\`.\n`;
  }).join('\n');
  return `# cappz-market commands\n\nGenerated from the tool's command table (packages/cappz-market/commands.ts). Every command prints JSON. Errors print \`{ "error", "next" }\` and exit 1. Every command also takes \`--demo\` (practice market), \`--as <party>\` (practice market only) and \`--yes\` (confirm a mainnet money movement).\n\n## Contents\n\n${toc}\n\n${body}`;
}
