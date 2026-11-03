/**
 * COPE node crystallized. Node ID: v15-25-00-cappz-market-mcp.
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * cappz-market as an MCP server over stdio (JSON-RPC 2.0, one message per
 * line). It runs on the agent's own computer — keys never leave it — and
 * exposes the same command table as the CLI: one tool per command, named
 * market_<command>, plus `demo` and `yes` on every tool.
 */
import { createInterface } from 'node:readline';
import { COMMANDS, type Command, type Param } from './commands';
import { ToolError } from './context';
import { VERSION } from './version';

const jsonType = (p: Param) => (p.type === 'json' ? 'object' : p.type);

export function toolList() {
  return COMMANDS.map((c) => ({
    name: `market_${c.name}`,
    description: c.summary + (c.money ? ' Moves money: on mainnet pass yes=true only after the person you act for agrees.' : ''),
    inputSchema: {
      type: 'object',
      properties: {
        ...Object.fromEntries(c.params.map((p) => [p.name, { type: jsonType(p), description: p.description }])),
        demo: { type: 'boolean', description: 'Use the practice market on this computer (nothing published, no real money).' },
        as: { type: 'string', description: 'Practice market only: act as this party id.' },
        ...(c.money ? { yes: { type: 'boolean', description: 'Confirms a mainnet money movement.' } } : {}),
      },
      required: c.params.filter((p) => p.required).map((p) => p.name),
      additionalProperties: false,
    },
  }));
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const cmd: Command | undefined = COMMANDS.find((c) => `market_${c.name}` === name);
  if (!cmd) return { content: [{ type: 'text', text: `Unknown tool ${name}.` }], isError: true };
  const { demo, as, yes, ...rest } = args;
  try {
    const out = await cmd.run(rest, { demo: !!demo, as: as ? String(as) : undefined, yes: !!yes });
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    const err = e instanceof ToolError ? { error: e.message, ...(e.next ? { next: e.next } : {}) } : { error: (e as Error).message };
    return { content: [{ type: 'text', text: JSON.stringify(err, null, 2) }], isError: true };
  }
}

export function serveMcp(): void {
  const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const reply = (result: unknown) => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result }); };
    switch (msg.method) {
      case 'initialize':
        reply({ protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cappz-market', version: VERSION }, instructions: 'CAPPZ Marketplace: start with market_setup. Read with market_find / market_show / market_deals; act with market_sell, market_ask, market_bid, market_award, market_buy, market_fund, market_deliver, market_release. Use demo=true to practise. Never move money on mainnet without the person you act for agreeing.' });
        return;
      case 'notifications/initialized': return;
      case 'ping': reply({}); return;
      case 'tools/list': reply({ tools: toolList() }); return;
      case 'tools/call': {
        const p = msg.params as { name: string; arguments?: Record<string, unknown> };
        void callTool(p.name, p.arguments ?? {}).then(reply);
        return;
      }
      default:
        if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  });
}
