/**
 * GF(2^8) with polynomial 0x11D and generator 2 — the field of
 * packages/cappz-native/src/gf.rs. Small matrix work (building and inverting
 * Reed-Solomon matrices) happens here; bulk shard math goes to the kernels.
 */

export const GF_EXP = new Uint8Array(512);
export const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x; GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

export function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

export function gfInv(a: number): number {
  if (a === 0) throw new Error('GF(256): zero has no inverse');
  return GF_EXP[255 - GF_LOG[a]];
}

export function gfPow(a: number, n: number): number {
  if (n === 0) return 1;
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] * n) % 255];
}

/** A row-major matrix of field elements. */
export type GfMatrix = Uint8Array[];

export function gfMatMul(a: GfMatrix, b: GfMatrix): GfMatrix {
  const n = b[0].length;
  return a.map((row) => {
    const out = new Uint8Array(n);
    row.forEach((v, i) => { if (v) for (let j = 0; j < n; j++) out[j] ^= gfMul(v, b[i][j]); });
    return out;
  });
}

/** Gauss-Jordan inverse; throws on a singular matrix. */
export function gfInvert(m: GfMatrix): GfMatrix {
  const n = m.length;
  const a = m.map((row, i) => { const r = new Uint8Array(2 * n); r.set(row); r[n + i] = 1; return r; });
  for (let col = 0; col < n; col++) {
    let pivot = col;
    while (pivot < n && a[pivot][col] === 0) pivot++;
    if (pivot === n) throw new Error('GF(256): singular matrix');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const inv = gfInv(a[col][col]);
    for (let j = 0; j < 2 * n; j++) a[col][j] = gfMul(a[col][j], inv);
    for (let r = 0; r < n; r++) {
      const f = a[r][col];
      if (r === col || f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] ^= gfMul(f, a[col][j]);
    }
  }
  return a.map((row) => row.slice(n));
}
