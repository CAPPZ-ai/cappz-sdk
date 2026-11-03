/**
 * MarketplaceMemoValidator
 *
 * Enforces the two-leg TX value-class model for cappz-marketplace:
 *   - Monetary leg: value carried in XRPL `Amount` field (drops/tokens)
 *   - Commodity leg: value carried in Memo with class+qty+unit+skuHdAddress
 *
 * Quantity MUST NEVER appear in the `Amount` field. This validator is the
 * runtime guard backing the type-level discriminated union in
 * `src/types/otcMarketplaceTypes.ts` (ValueClass union).
 *
 * Used by:
 *   - cappz-marketplace (new project) before submitting TXs
 *   - XRPLChainletAnchor on the CAPPZ side as a final pre-submit gate
 *   - Audit replay to detect malformed legacy TXs
 */

export type ValueClass = 'monetary' | 'commodity';

export interface MonetaryLegMemo {
  class: 'monetary';
  contractId: string;
  deliveryIndex: number;
  /** Optional human-readable currency code; authoritative amount is XRPL Amount field. */
  currency?: string;
}

export interface CommodityLegMemo {
  class: 'commodity';
  contractId: string;
  deliveryIndex: number;
  qty: number;
  unit: string;
  skuHdAddress: string;
  /** Optional batch / lot identifier for inventory provenance. */
  lotId?: string;
}

export type MarketplaceMemo = MonetaryLegMemo | CommodityLegMemo;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface PreparedTxLike {
  TransactionType?: string;
  Amount?: string | { value: string; currency: string; issuer?: string };
  Memos?: Array<{ Memo?: { MemoType?: string; MemoData?: string; MemoFormat?: string } }>;
}

const MEMO_TYPE_MONETARY = 'cappz-marketplace-monetary';
const MEMO_TYPE_COMMODITY = 'cappz-marketplace-commodity';

// TextEncoder/TextDecoder work in browsers and Node; Buffer is Node-only and broke the validator in the browser.
function hexToUtf8(hex: string): string {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) return '';
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return ''; }
}

function utf8ToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Validate a parsed marketplace memo payload against the value-class contract.
 */
export function validateMemo(memo: unknown): ValidationResult {
  const errors: string[] = [];
  if (!memo || typeof memo !== 'object') {
    return { ok: false, errors: ['memo missing or not an object'] };
  }
  const m = memo as Record<string, unknown>;

  if (m.class !== 'monetary' && m.class !== 'commodity') {
    errors.push(`memo.class must be "monetary" or "commodity" (got: ${String(m.class)})`);
  }
  if (typeof m.contractId !== 'string' || !m.contractId) {
    errors.push('memo.contractId required (string)');
  }
  if (typeof m.deliveryIndex !== 'number' || m.deliveryIndex < 0) {
    errors.push('memo.deliveryIndex required (non-negative number)');
  }

  if (m.class === 'commodity') {
    if (typeof m.qty !== 'number' || m.qty <= 0) {
      errors.push('commodity memo.qty required (positive number)');
    }
    if (typeof m.unit !== 'string' || !m.unit) {
      errors.push('commodity memo.unit required (non-empty string)');
    }
    if (typeof m.skuHdAddress !== 'string' || !m.skuHdAddress) {
      errors.push('commodity memo.skuHdAddress required (non-empty string)');
    }
  } else if (m.class === 'monetary') {
    // Monetary memos must NOT carry quantity/unit — those belong to commodity leg.
    if ('qty' in m || 'unit' in m || 'skuHdAddress' in m) {
      errors.push('monetary memo must not contain qty/unit/skuHdAddress (use a paired commodity TX)');
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a prepared XRPL TX before submission. Enforces:
 *   - Monetary TX: must have Amount, must NOT encode quantity in memo
 *   - Commodity TX: Amount must be the minimal carrier (1 drop) — never the qty
 */
export function validatePreparedTx(tx: PreparedTxLike): ValidationResult {
  const errors: string[] = [];
  const memos = tx.Memos ?? [];

  const marketplaceMemos: { type: string; payload: unknown }[] = [];
  for (const wrapper of memos) {
    const memo = wrapper.Memo;
    if (!memo?.MemoType || !memo.MemoData) continue;
    const type = hexToUtf8(memo.MemoType);
    if (type !== MEMO_TYPE_MONETARY && type !== MEMO_TYPE_COMMODITY) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(hexToUtf8(memo.MemoData));
    } catch {
      errors.push(`memo "${type}" MemoData is not valid JSON`);
      continue;
    }
    marketplaceMemos.push({ type, payload });
  }

  if (marketplaceMemos.length === 0) {
    // Not a marketplace TX — nothing to validate.
    return { ok: true, errors: [] };
  }

  if (marketplaceMemos.length > 1) {
    errors.push('a single TX may carry only one marketplace memo (split into paired TXs)');
  }

  for (const { type, payload } of marketplaceMemos) {
    const result = validateMemo(payload);
    errors.push(...result.errors);

    const declaredClass = (payload as { class?: string })?.class;
    if (type === MEMO_TYPE_MONETARY && declaredClass !== 'monetary') {
      errors.push(`MemoType "${type}" requires class="monetary"`);
    }
    if (type === MEMO_TYPE_COMMODITY && declaredClass !== 'commodity') {
      errors.push(`MemoType "${type}" requires class="commodity"`);
    }

    if (declaredClass === 'commodity') {
      // Commodity TX: Amount must be exactly "1" drop (minimal carrier).
      // The economic value is in the memo (qty), never in Amount.
      if (typeof tx.Amount !== 'string' || tx.Amount !== '1') {
        errors.push('commodity TX Amount must be exactly "1" drop (carrier only — qty lives in memo)');
      }
    }

    if (declaredClass === 'monetary') {
      if (!tx.Amount) {
        errors.push('monetary TX must have Amount field');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Build a properly-typed XRPL Memo entry for either leg. */
export function buildMemo(payload: MarketplaceMemo): { Memo: { MemoType: string; MemoData: string; MemoFormat: string } } {
  const validation = validateMemo(payload);
  if (!validation.ok) {
    throw new Error(`Invalid marketplace memo: ${validation.errors.join('; ')}`);
  }
  const memoType = payload.class === 'monetary' ? MEMO_TYPE_MONETARY : MEMO_TYPE_COMMODITY;
  return {
    Memo: {
      MemoType: utf8ToHex(memoType),
      MemoData: utf8ToHex(JSON.stringify(payload)),
      MemoFormat: utf8ToHex('application/json'),
    },
  };
}

/** Assert variant: throws if validation fails. Use as the final pre-submit gate. */
export function assertValidPreparedTx(tx: PreparedTxLike): void {
  const result = validatePreparedTx(tx);
  if (!result.ok) {
    throw new Error(`MarketplaceMemoValidator rejected TX: ${result.errors.join('; ')}`);
  }
}

export const MARKETPLACE_MEMO_TYPES = {
  MONETARY: MEMO_TYPE_MONETARY,
  COMMODITY: MEMO_TYPE_COMMODITY,
} as const;
