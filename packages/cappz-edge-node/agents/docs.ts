/**
 * Docs the paid agents serve (15.43.0): templates in ./docs filled with the
 * instance's live values, so a person, an agent and the marketplace card all
 * read the same price, network, payout address and signer the agent uses.
 *
 *   <base>/                guide for people (try-it forms, in-browser verifier)
 *   <base>/llms.txt        one page for agents
 *   <base>/<agent>/SKILL.md  an Agent Skill per agent
 *   <base>/verify.mjs      offline verifier (Node 20+ or Deno, no dependencies)
 *
 * Pure: no I/O, so tests can check every template's placeholders.
 */

export interface DocSettings {
  publicBase: string;
  network: 'mainnet' | 'testnet' | 'devnet';
  payTo: string;
  nodePublicKeyHex: string;
  timestampPrice: number;
  webhookPrice: number;
  webhookDays: number;
  /** Fair draw (15.47.0); defaults 0.1 XRP, 30 days, 120 s. */
  drawPrice?: number;
  drawMaxDays?: number;
  drawMinLeadSeconds?: number;
  /** Vault check and vault guard (15.49.0); defaults 1 XRP, 10 XRP per 30 days. */
  vaultCheckPrice?: number;
  vaultGuardPrice?: number;
  vaultGuardDays?: number;
  /** The same agents on the other network ('' when there is none). */
  peerBase?: string;
}

/** Webhook stage shares: deposit opens the endpoint, the rest pays for the bundle. */
export const WEBHOOK_DEPOSIT_SHARE = 0.3;

/** Request path below /agents → template file and content type. */
export const DOC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/llms.txt': { file: 'llms.txt', type: 'text/plain; charset=utf-8' },
  '/timestamp/SKILL.md': { file: 'timestamp.SKILL.md', type: 'text/markdown; charset=utf-8' },
  '/webhook/SKILL.md': { file: 'webhook.SKILL.md', type: 'text/markdown; charset=utf-8' },
  '/draw/SKILL.md': { file: 'draw.SKILL.md', type: 'text/markdown; charset=utf-8' },
  '/vault-check/SKILL.md': { file: 'vault-check.SKILL.md', type: 'text/markdown; charset=utf-8' },
  '/vault-guard/SKILL.md': { file: 'vault-guard.SKILL.md', type: 'text/markdown; charset=utf-8' },
  /** A draw's public page (also served at /draw/draws/<jobId> to browsers). */
  '/draw/view': { file: 'draw.html', type: 'text/html; charset=utf-8' },
  '/verify.mjs': { file: 'verify.mjs', type: 'text/javascript; charset=utf-8' },
};

const round = (n: number) => Number(n.toFixed(6)).toString();

export function docVars(s: DocSettings): Record<string, string> {
  return {
    BASE: s.publicBase, HOST: new URL(s.publicBase).host, NETWORK: s.network, PAYTO: s.payTo, NODE: s.nodePublicKeyHex,
    DAYS: String(s.webhookDays), TS_PRICE: round(s.timestampPrice), WH_PRICE: round(s.webhookPrice),
    WH_DEPOSIT: round(s.webhookPrice * WEBHOOK_DEPOSIT_SHARE), WH_REST: round(s.webhookPrice * (1 - WEBHOOK_DEPOSIT_SHARE)),
    PEER_BASE: s.peerBase ?? '', PEER_NETWORK: s.network === 'mainnet' ? 'testnet' : 'mainnet',
    DRAW_PRICE: round(s.drawPrice ?? 0.1), DRAW_MAX_DAYS: String(s.drawMaxDays ?? 30),
    DRAW_LEAD: String(Math.round((s.drawMinLeadSeconds ?? 120) / 60 * 10) / 10),
    VC_PRICE: round(s.vaultCheckPrice ?? 1), VG_PRICE: round(s.vaultGuardPrice ?? 10), VG_DAYS: String(s.vaultGuardDays ?? 30),
  };
}

/** Fills {{NAME}} placeholders; an unknown name is left as written so a test can catch it. */
export function renderDoc(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

/** Placeholders a template uses that vars does not define. */
export function unfilled(template: string, vars: Record<string, string>): string[] {
  return [...new Set([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]).filter((k) => !(k in vars)))];
}
