import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildNotaryBatch, rootFromInclusion, verifyNotaryInclusion, notaryBatchMemoPayload, NOTARY_BATCH_MEMO_TYPE } from '../lib/crypto/notaryBatch';
import { verifyClient } from '../lib/crypto/clientVerify';

const h = (...parts: (number[] | Buffer)[]) => { const x = createHash('sha256'); for (const p of parts) x.update(Buffer.from(p as number[])); return x.digest(); };

/** Independent RFC 6962 MTH over arbitrary leaf data, checked against the CT reference vectors below. */
function referenceRoot(data: Buffer[]): Buffer {
  if (data.length === 1) return h([0], data[0]);
  let k = 1; while (k * 2 < data.length) k *= 2;
  return h([1], referenceRoot(data.slice(0, k)), referenceRoot(data.slice(k)));
}

// certificate-transparency reference test data: leaves and the root of the first n.
const CT_LEAVES = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'].map((x) => Buffer.from(x, 'hex'));
const CT_ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

const leafOf = (i: number) => createHash('sha256').update(`file ${i}`).digest('hex').toUpperCase();

describe('v15-16-00 notary batches (RFC 9162 Merkle tree)', () => {
  it('the reference tree reproduces the certificate-transparency vectors', () => {
    CT_ROOTS.forEach((root, i) => expect(referenceRoot(CT_LEAVES.slice(0, i + 1)).toString('hex'), `n=${i + 1}`).toBe(root));
  });

  it('roots match the reference, and every proof verifies, for every batch size 1..40', () => {
    for (let n = 1; n <= 40; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leafOf(i + 100 * n));
      const b = buildNotaryBatch(leaves);
      expect(b.root, `n=${n}`).toBe(referenceRoot(leaves.map((l) => Buffer.from(l, 'hex'))).toString('hex').toUpperCase());
      expect(b.count).toBe(n);
      b.proofs.forEach((p, i) => {
        expect(p.index).toBe(i);
        expect(p.path.length).toBeLessThanOrEqual(Math.ceil(Math.log2(n)));
        expect(verifyNotaryInclusion(leaves[i], p, b), `n=${n} i=${i}`).toBe(true);
      });
    }
  });

  it('refuses tampered proofs: other leaf, index, count, path entry, extra or missing step', () => {
    const leaves = Array.from({ length: 13 }, (_, i) => leafOf(i));
    const b = buildNotaryBatch(leaves);
    const p = b.proofs[6];
    expect(verifyNotaryInclusion(leaves[6], p, b)).toBe(true);
    expect(verifyNotaryInclusion(leaves[7], p, b)).toBe(false);
    expect(verifyNotaryInclusion(leaves[6], { ...p, index: 7 }, b)).toBe(false);
    // A path inside the left subtree is the same for 13 or 14 leaves, so the
    // anchored count is what binds the size: a proof claiming another count fails.
    expect(verifyNotaryInclusion(leaves[6], { ...p, count: 14 }, b)).toBe(false);
    expect(verifyNotaryInclusion(leaves[6], { ...p, count: 12 }, b)).toBe(false);
    expect(verifyNotaryInclusion(leaves[6], p, { root: b.root, count: 14 })).toBe(false);
    const flipped = [...p.path]; flipped[1] = (flipped[1][0] === 'A' ? 'B' : 'A') + flipped[1].slice(1);
    expect(verifyNotaryInclusion(leaves[6], { ...p, path: flipped }, b)).toBe(false);
    expect(verifyNotaryInclusion(leaves[6], { ...p, path: [...p.path, p.path[0]] }, b)).toBe(false);
    expect(verifyNotaryInclusion(leaves[6], { ...p, path: p.path.slice(1) }, b)).toBe(false);
    expect(rootFromInclusion(leaves[6], { ...p, index: 13 })).toBeNull();
    expect(rootFromInclusion(leaves[6], { ...p, index: -1 })).toBeNull();
    expect(rootFromInclusion('XYZ', p)).toBeNull();
  });

  it('an inner node cannot pass as a notarized leaf (domain separation)', () => {
    const leaves = [leafOf(1), leafOf(2), leafOf(3), leafOf(4)];
    const b = buildNotaryBatch(leaves);
    // The node over leaves 0..1 is the first entry of leaf 2's path. Presenting it as a leaf of a
    // 2-leaf view of the tree must not reproduce the root.
    const inner = b.proofs[2].path[1];
    const sibling = b.proofs[0].path[1];
    expect(verifyNotaryInclusion(inner, { index: 0, count: 2, path: [sibling] }, { root: b.root, count: 2 })).toBe(false);
  });

  it('rejects malformed batches', () => {
    expect(() => buildNotaryBatch([])).toThrow(/no leaves/);
    expect(() => buildNotaryBatch(['abc'])).toThrow(/64 hex/);
  });

  it('verifyClient checks a batch receipt against the root on the ledger', async () => {
    const leaves = Array.from({ length: 5 }, (_, i) => leafOf(i));
    const b = buildNotaryBatch(leaves);
    const memo = notaryBatchMemoPayload({ root: b.root, count: b.count });
    const hexOf = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
    const tx = { validated: true, ledger_index: 7, Account: 'rAnchor', InvoiceID: b.root, Memos: [{ Memo: { MemoType: hexOf(NOTARY_BATCH_MEMO_TYPE), MemoData: hexOf(JSON.stringify(memo)) } }] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: tx }))) as typeof fetch;
    try {
      const ok = await verifyClient({ txId: 'T', expectedLeaf: leaves[3], inclusion: b.proofs[3] });
      expect(ok.verified).toBe(true);
      expect(ok.onChainRoot).toBe(b.root);
      expect(ok.onChainLeaf).toBeUndefined();
      expect((await verifyClient({ txId: 'T', expectedLeaf: leaves[2], inclusion: b.proofs[3] })).verified).toBe(false);
      const noProof = await verifyClient({ txId: 'T', expectedLeaf: leaves[3] });
      expect(noProof.verified).toBe(false);
      expect(noProof.error).toMatch(/inclusion proof/);
      // An anchor that does not commit to its leaf count cannot verify anything.
      const { count: _c, ...noCount } = memo;
      tx.Memos[0].Memo.MemoData = hexOf(JSON.stringify(noCount));
      expect((await verifyClient({ txId: 'T', expectedLeaf: leaves[3], inclusion: b.proofs[3] })).verified).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
