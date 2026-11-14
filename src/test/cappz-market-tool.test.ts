import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, commandOf } from '../../packages/cappz-market/commands';
import { parseArgs, HELP_GROUPS } from '../../packages/cappz-market/main';
import { skillsIndex } from '../../packages/cappz-market/skillsIndex';
import { searchSkills } from '../../packages/cappz-market/skillsSearch';
import { callTool, toolList } from '../../packages/cappz-market/mcp';
import { marketNetwork } from '../../packages/cappz-market/context';
import { MARKET_NETWORKS, PUBLIC_LOG_PARTITION, marketPartition } from '../lib/marketplace/publicLog';
import { settlementPolicyFor } from '../lib/marketplace/settlement';
import { commandsMarkdown } from '../../packages/cappz-market/docs';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/** Repo-relative paths resolved from this file, so the test also passes when a host app runs it from node_modules. */
const repo = (p: string) => resolvePath(__dirname, '../..', p);

// cappz-market: one command table, served as a CLI and as MCP tools, running the marketplace's own builders.
const run = async (name: string, args: Record<string, unknown>, o: Record<string, unknown> = {}) => commandOf(name)!.run(args, { demo: true, ...o });

beforeAll(() => { process.env.CAPPZ_HOME = mkdtempSync(join(tmpdir(), 'cappz-market-')); delete process.env.XRPL_SEED; });

describe('cappz-market tool', () => {
  it('runs a whole deal on the practice market: find, buy, fund, deliver (seller), release, review', async () => {
    await run('demo', { reset: true });
    const found = await run('find', { text: 'holy basil' }) as { forSale: Array<{ id: string }> };
    expect(found.forSale.length).toBeGreaterThan(0);
    const bought = await run('buy', { listing: 'l-basil-nc', quantity: 2 }) as { contractId: string };
    expect(bought.contractId).toMatch(/^ct-/);
    await run('fund', { contract: bought.contractId });
    const file = join(process.env.CAPPZ_HOME!, 'receipt.txt'); writeFileSync(file, 'signed delivery receipt');
    const ev = await run('deliver', { contract: bought.contractId, file }, { as: 'blue-ridge-herbs' }) as { sha256: string };
    expect(ev.sha256).toMatch(/^[0-9a-f]{64}$/);
    await run('release', { contract: bought.contractId });
    await run('review', { contract: bought.contractId, rating: 5, text: 'On time.' });
    const deals = await run('deals', {}) as { deals: Array<{ id: string; state: string; escrow: { released: number } }> };
    const d = deals.deals.find((x) => x.id === bought.contractId)!;
    expect(d.state).toBe('completed');
    expect(d.escrow.released).toBeGreaterThan(0);
  });

  it('asks, bids (as another party), awards and forms a contract; rules refuse bad input with a next step', async () => {
    const asked = await run('ask', { title: 'Translate 40 product pages to Spanish', category: 'agents', quantity: 40, unit: 'task', maxPrice: 3, currency: 'USD' }) as { requestId: string };
    const bid = await run('bid', { request: asked.requestId, price: 2.5 }, { as: 'agentco' }) as { bidId: string };
    const awarded = await run('award', { request: asked.requestId, bid: bid.bidId }) as { contractId: string };
    expect(awarded.contractId).toMatch(/^ct-/);
    await expect(run('ask', { title: 'x', category: 'no-such', quantity: 1 })).rejects.toThrow(/Unknown category/);
    await expect(run('show', { id: 'nothing-here' })).rejects.toThrow(/Nothing with id/);
  });

  it('parses flags, positionals and kebab-case; unknown options fail with a hint', () => {
    const p = parseArgs(commandOf('bid')!, ['rq-1', '--price', '3', '--by=2026-12-01', '--demo', '--as', 'agentco']);
    expect(p.args).toEqual({ request: 'rq-1', price: '3', by: '2026-12-01' });
    expect(p.global).toEqual({ demo: true, as: 'agentco', yes: false });
    expect(parseArgs(commandOf('sell')!, ['--lead-days', '3']).args).toEqual({ leadDays: '3' });
    expect(() => parseArgs(commandOf('find')!, ['--nope'])).toThrow(/Unknown option/);
  });

  it('serves the same commands as MCP tools; money-moving tools say so and take `yes`', async () => {
    const tools = toolList();
    expect(tools.map((t) => t.name)).toEqual(COMMANDS.map((c) => `market_${c.name}`));
    const fund = tools.find((t) => t.name === 'market_fund')!;
    expect(fund.description).toMatch(/Moves money/);
    expect(Object.keys(fund.inputSchema.properties)).toContain('yes');
    const r = await callTool('market_find', { text: 'dahlias', demo: true });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).forSale.length).toBeGreaterThan(0);
    const bad = await callTool('market_show', { id: 'nope', demo: true });
    expect(bad.isError).toBe(true);
  });

  it('keeps keys on this computer: no wallet means a clear next step, never a generated secret in output', async () => {
    const out = await callTool('market_wallet', { demo: true });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text).next).toMatch(/wallet --new|XRPL_SEED/);
  });

  it('the skill\'s command reference is generated from this table and up to date', () => {
    expect(readFileSync(repo('skills/using-cappz-marketplace/reference/commands.md'), 'utf8')).toBe(commandsMarkdown());
  });

  it('skills/index.json is generated from the skills and up to date, and every skill folder is in it', () => {
    const fresh = skillsIndex(repo('skills') + '/');
    expect(JSON.parse(readFileSync(repo('skills/index.json'), 'utf8'))).toEqual(fresh);
    expect(fresh.skills.length).toBeGreaterThanOrEqual(15);
    for (const s of fresh.skills) { expect(s.description).toMatch(/\bUse (when|before)/); expect(s.raw).toMatch(/^https:\/\/raw\.githubusercontent\.com\/CAPPZ-ai\/cappz-sdk\/main\/skills\/[a-z0-9-]+\/SKILL\.md$/); }
    // Every skill a command's --help links mentions that command, so the link is never a guess.
    expect(fresh.skills.find((s) => s.name === 'securing-control-systems')!.commands).toEqual(expect.arrayContaining(['constraints-draft', 'constraints-review']));
    expect(fresh.skills.find((s) => s.name === 'monitoring-constraints')!.commands).toContain('constraints-triage');
  });

  it('skills <words> finds the right skill for plain requests (whole words, stopwords ignored), and lists all with no words', async () => {
    const idx = skillsIndex(repo('skills') + '/');
    const top = (q: string) => searchSkills(idx, q)[0]?.name;
    expect(top('our freezer setpoint was hacked')).toBe('securing-control-systems');
    expect(top('modbus write protection')).toBe('securing-control-systems');
    expect(top('a reconciliation alert fired on the oven')).toBe('monitoring-constraints');
    expect(top('wire instructions changed by email')).toBe('confirming-payees');
    expect(top('sell my agent work')).toBe('selling-agent-work-on-cappz');
    expect(top('set up a wallet')).toBe('getting-an-xrpl-wallet');
    expect(searchSkills(idx, 'zzqx')).toEqual([]);
    expect(searchSkills(idx, 'the of and')).toHaveLength(idx.skills.length);
    const out = await run('skills', { query: 'freezer hacked' }) as { skills: Array<{ name: string; skill: string }>; next: string };
    expect(out.skills[0].name).toBe('securing-control-systems');
    expect(out.next).toContain(out.skills[0].skill);
    const none = await run('skills', { query: 'zzqx' }) as { none: string; next: string };
    expect(none.none).toMatch(/No skill/); expect(none.next).toBe('cappz-market skills (lists every skill)');
  });

  it('the main help menu puts every command in exactly one group', () => {
    const grouped = HELP_GROUPS.flatMap(([, names]) => names);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(COMMANDS.map((c) => c.name).sort());
  });

  it('every skill has valid frontmatter (name, third-person description with when-to-use) and stays under 500 lines', () => {
    for (const name of ['using-cappz-marketplace', 'hiring-cappz-paid-agents', 'selling-agent-work-on-cappz', 'getting-an-xrpl-wallet', 'signing-up-for-cappz', 'checking-xrpl-counterparties', 'securing-control-systems', 'monitoring-constraints']) {
      const md = readFileSync(repo(`skills/${name}/SKILL.md`), 'utf8');
      const fm = /^---\nname: ([a-z0-9-]{1,64})\ndescription: (.+)\n---\n/.exec(md)!;
      expect(fm[1]).toBe(name);
      expect(fm[2].length).toBeLessThanOrEqual(1024);
      expect(fm[2]).toMatch(/Use when/);
      expect(fm[2]).not.toMatch(/\b(I|you) can\b/i);
      expect(md.split('\n').length).toBeLessThan(500);
      for (const link of md.matchAll(/\]\((reference\/[^)]+)\)/g)) expect(() => readFileSync(repo(`skills/${name}/${link[1]}`))).not.toThrow();
    }
  });

  it('one market per network: testnet is the default and keeps the original log; each network has its own partition and policy', () => {
    delete process.env.CAPPZ_NETWORK;
    expect(marketNetwork({})).toBe('testnet');
    expect(marketNetwork({ network: 'Mainnet' })).toBe('mainnet');
    expect(() => marketNetwork({ network: 'moon' })).toThrow(/Unknown network/);
    expect(marketPartition('testnet')).toBe(PUBLIC_LOG_PARTITION);
    expect(new Set(MARKET_NETWORKS.map(marketPartition)).size).toBe(3);
    for (const n of MARKET_NETWORKS) expect(settlementPolicyFor(n).network).toBe(n);
    const p = parseArgs(commandOf('find')!, ['tea', '--network', 'mainnet']);
    expect(p.global.network).toBe('mainnet');
    expect(Object.keys(toolList()[0].inputSchema.properties)).toContain('network');
  });

  it('a principal grants and revokes its agent\'s mandate with the tool; an agent cannot grant itself one', async () => {
    const g = await run('mandate', { agent: 'agent-fieldops', actions: 'sell', categories: 'services', maxContract: 500 }, { as: 'jones-custom' }) as { mandateId: string; recorded: string[] };
    expect(g.recorded).toEqual(['PermissionGranted']);
    await expect(run('mandate', { agent: 'agent-fieldops' }, { as: 'agent-fieldops' })).rejects.toThrow(/cannot grant/);
    const r = await run('mandate', { revoke: g.mandateId }, { as: 'jones-custom' }) as { recorded: string[] };
    expect(r.recorded).toEqual(['PermissionRevoked']);
  });
});
