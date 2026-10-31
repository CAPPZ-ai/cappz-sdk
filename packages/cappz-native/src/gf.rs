//! GF(2^8) arithmetic (polynomial 0x11D, generator 2) and the one hot kernel
//! Reed-Solomon needs: `out[r] = XOR_j coeff[r][j] * in[j]` over whole shards.
//!
//! Matrix construction and inversion are tiny and live in TypeScript
//! (`src/lib/erasure/reedSolomon.ts`); every backend — this crate natively,
//! this crate compiled to WASM, the C++ twin and the TypeScript fallback —
//! runs the same kernel, so their outputs are byte-identical by test.

/// Bytes per tile: inputs and outputs of a tile stay in L1/L2 while every
/// coefficient is applied, instead of streaming whole shards per coefficient.
pub const TILE: usize = 16 * 1024;

const fn tables() -> ([u8; 512], [u8; 256]) {
    let mut exp = [0u8; 512];
    let mut log = [0u8; 256];
    let mut x: u16 = 1;
    let mut i = 0;
    while i < 255 {
        exp[i] = x as u8;
        log[x as usize] = i as u8;
        x <<= 1;
        if x & 0x100 != 0 {
            x ^= 0x11d;
        }
        i += 1;
    }
    while i < 512 {
        exp[i] = exp[i - 255];
        i += 1;
    }
    (exp, log)
}

const TABLES: ([u8; 512], [u8; 256]) = tables();
pub const EXP: [u8; 512] = TABLES.0;
pub const LOG: [u8; 256] = TABLES.1;

#[inline]
pub const fn mul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        0
    } else {
        EXP[LOG[a as usize] as usize + LOG[b as usize] as usize]
    }
}

/// Split-nibble product tables for one coefficient: `c*x = lo[x & 15] ^ hi[x >> 4]`.
#[inline]
fn nibble_tables(c: u8) -> ([u8; 16], [u8; 16]) {
    let mut lo = [0u8; 16];
    let mut hi = [0u8; 16];
    for i in 0..16u8 {
        lo[i as usize] = mul(c, i);
        hi[i as usize] = mul(c, i << 4);
    }
    (lo, hi)
}

/// Which implementation runs the inner loop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kernel {
    Scalar,
    #[cfg(target_arch = "aarch64")]
    Neon,
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    Simd128,
}

impl Kernel {
    pub fn best() -> Kernel {
        #[cfg(target_arch = "aarch64")]
        {
            // Advanced SIMD is mandatory on AArch64.
            return Kernel::Neon;
        }
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        {
            return Kernel::Simd128;
        }
        #[allow(unreachable_code)]
        Kernel::Scalar
    }

    pub fn name(self) -> &'static str {
        match self {
            Kernel::Scalar => "scalar",
            #[cfg(target_arch = "aarch64")]
            Kernel::Neon => "neon",
            #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
            Kernel::Simd128 => "simd128",
        }
    }
}

/// `out (^)= c * input` for one coefficient. `assign` overwrites instead of
/// accumulating, which saves zeroing the outputs first.
#[inline]
fn mul_slice(kernel: Kernel, c: u8, input: &[u8], out: &mut [u8], assign: bool) {
    debug_assert_eq!(input.len(), out.len());
    match kernel {
        Kernel::Scalar => mul_slice_scalar(c, input, out, assign),
        #[cfg(target_arch = "aarch64")]
        Kernel::Neon => unsafe { mul_slice_neon(c, input, out, assign) },
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        Kernel::Simd128 => unsafe { mul_slice_simd128(c, input, out, assign) },
    }
}

fn mul_slice_scalar(c: u8, input: &[u8], out: &mut [u8], assign: bool) {
    let mut row = [0u8; 256];
    for (x, slot) in row.iter_mut().enumerate() {
        *slot = mul(c, x as u8);
    }
    if assign {
        for (o, &x) in out.iter_mut().zip(input) {
            *o = row[x as usize];
        }
    } else {
        for (o, &x) in out.iter_mut().zip(input) {
            *o ^= row[x as usize];
        }
    }
}

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
unsafe fn mul_slice_neon(c: u8, input: &[u8], out: &mut [u8], assign: bool) {
    use core::arch::aarch64::*;
    let (lo, hi) = nibble_tables(c);
    let tlo = vld1q_u8(lo.as_ptr());
    let thi = vld1q_u8(hi.as_ptr());
    let mask = vdupq_n_u8(0x0f);
    let n = input.len();
    let ip = input.as_ptr();
    let op = out.as_mut_ptr();
    let mut i = 0;
    // 64 bytes per iteration: four independent table-lookup chains keep the
    // TBL units busy.
    while i + 64 <= n {
        let x0 = vld1q_u8(ip.add(i));
        let x1 = vld1q_u8(ip.add(i + 16));
        let x2 = vld1q_u8(ip.add(i + 32));
        let x3 = vld1q_u8(ip.add(i + 48));
        let p0 = veorq_u8(vqtbl1q_u8(tlo, vandq_u8(x0, mask)), vqtbl1q_u8(thi, vshrq_n_u8::<4>(x0)));
        let p1 = veorq_u8(vqtbl1q_u8(tlo, vandq_u8(x1, mask)), vqtbl1q_u8(thi, vshrq_n_u8::<4>(x1)));
        let p2 = veorq_u8(vqtbl1q_u8(tlo, vandq_u8(x2, mask)), vqtbl1q_u8(thi, vshrq_n_u8::<4>(x2)));
        let p3 = veorq_u8(vqtbl1q_u8(tlo, vandq_u8(x3, mask)), vqtbl1q_u8(thi, vshrq_n_u8::<4>(x3)));
        if assign {
            vst1q_u8(op.add(i), p0);
            vst1q_u8(op.add(i + 16), p1);
            vst1q_u8(op.add(i + 32), p2);
            vst1q_u8(op.add(i + 48), p3);
        } else {
            vst1q_u8(op.add(i), veorq_u8(vld1q_u8(op.add(i)), p0));
            vst1q_u8(op.add(i + 16), veorq_u8(vld1q_u8(op.add(i + 16)), p1));
            vst1q_u8(op.add(i + 32), veorq_u8(vld1q_u8(op.add(i + 32)), p2));
            vst1q_u8(op.add(i + 48), veorq_u8(vld1q_u8(op.add(i + 48)), p3));
        }
        i += 64;
    }
    while i + 16 <= n {
        let x = vld1q_u8(ip.add(i));
        let p = veorq_u8(vqtbl1q_u8(tlo, vandq_u8(x, mask)), vqtbl1q_u8(thi, vshrq_n_u8::<4>(x)));
        let p = if assign { p } else { veorq_u8(vld1q_u8(op.add(i)), p) };
        vst1q_u8(op.add(i), p);
        i += 16;
    }
    if i < n {
        mul_slice_scalar(c, &input[i..], &mut out[i..], assign);
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[target_feature(enable = "simd128")]
unsafe fn mul_slice_simd128(c: u8, input: &[u8], out: &mut [u8], assign: bool) {
    use core::arch::wasm32::*;
    let (lo, hi) = nibble_tables(c);
    let tlo = v128_load(lo.as_ptr() as *const v128);
    let thi = v128_load(hi.as_ptr() as *const v128);
    let mask = u8x16_splat(0x0f);
    let n = input.len();
    let ip = input.as_ptr();
    let op = out.as_mut_ptr();
    let mut i = 0;
    while i + 16 <= n {
        let x = v128_load(ip.add(i) as *const v128);
        let p = v128_xor(
            u8x16_swizzle(tlo, v128_and(x, mask)),
            u8x16_swizzle(thi, u8x16_shr(x, 4)),
        );
        let p = if assign { p } else { v128_xor(v128_load(op.add(i) as *const v128), p) };
        v128_store(op.add(i) as *mut v128, p);
        i += 16;
    }
    if i < n {
        mul_slice_scalar(c, &input[i..], &mut out[i..], assign);
    }
}

/// `outputs[r] = XOR_j coeffs[r*k + j] * inputs[j]`, tiled for cache.
/// All shards have the same length. A zero coefficient row yields zeros.
pub fn matmul(kernel: Kernel, coeffs: &[u8], inputs: &[&[u8]], outputs: &mut [&mut [u8]]) {
    let k = inputs.len();
    let rows = outputs.len();
    assert_eq!(coeffs.len(), rows * k, "coeffs must be rows x k");
    let len = inputs.first().map_or(0, |s| s.len());
    assert!(inputs.iter().all(|s| s.len() == len), "inputs differ in length");
    assert!(outputs.iter().all(|s| s.len() == len), "outputs differ in length");
    let mut at = 0;
    while at < len {
        let end = (at + TILE).min(len);
        for (r, out) in outputs.iter_mut().enumerate() {
            let out = &mut out[at..end];
            let mut first = true;
            for (j, input) in inputs.iter().enumerate() {
                let c = coeffs[r * k + j];
                if c == 0 {
                    continue;
                }
                mul_slice(kernel, c, &input[at..end], out, first);
                first = false;
            }
            if first {
                out.fill(0);
            }
        }
        at = end;
    }
}

/// `matmul` split by byte range across `threads` OS threads. Each thread owns
/// a disjoint slice of every output, so no synchronisation is needed.
#[cfg(not(target_arch = "wasm32"))]
pub fn matmul_parallel(kernel: Kernel, coeffs: &[u8], inputs: &[&[u8]], outputs: &mut [&mut [u8]], threads: usize) {
    let len = inputs.first().map_or(0, |s| s.len());
    let threads = threads.max(1);
    // Each thread touches k + rows shard slices; below ~1 MiB of traffic per
    // thread the spawn cost outweighs the work.
    let traffic = len * (inputs.len() + outputs.len());
    if threads == 1 || traffic < threads * 1024 * 1024 {
        return matmul(kernel, coeffs, inputs, outputs);
    }
    let per = (len.div_ceil(threads) + 63) & !63;
    // Carve each output into per-thread pieces up front.
    let mut pieces: Vec<Vec<&mut [u8]>> = (0..threads).map(|_| Vec::with_capacity(outputs.len())).collect();
    for out in outputs.iter_mut() {
        let mut rest: &mut [u8] = out;
        for piece in pieces.iter_mut() {
            let take = per.min(rest.len());
            let (head, tail) = rest.split_at_mut(take);
            piece.push(head);
            rest = tail;
        }
    }
    std::thread::scope(|s| {
        for (t, mut outs) in pieces.into_iter().enumerate() {
            let start = (t * per).min(len);
            let end = ((t + 1) * per).min(len);
            if start == end {
                continue;
            }
            let ins: Vec<&[u8]> = inputs.iter().map(|i| &i[start..end]).collect();
            s.spawn(move || matmul(kernel, coeffs, &ins, &mut outs));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_axioms() {
        for a in 0..=255u8 {
            assert_eq!(mul(a, 1), a);
            assert_eq!(mul(a, 0), 0);
            if a != 0 {
                let inv = EXP[255 - LOG[a as usize] as usize];
                assert_eq!(mul(a, inv), 1);
            }
        }
    }

    #[test]
    fn kernels_agree() {
        let k = 5;
        let rows = 3;
        let len = 100_003; // odd tail on purpose
        let inputs: Vec<Vec<u8>> = (0..k).map(|j| (0..len).map(|i| ((i * 31 + j * 7) % 251) as u8).collect()).collect();
        let coeffs: Vec<u8> = (0..rows * k).map(|i| (i * 37 + 1) as u8).collect();
        let ins: Vec<&[u8]> = inputs.iter().map(|v| v.as_slice()).collect();
        let mut a = vec![vec![0u8; len]; rows];
        let mut b = vec![vec![0u8; len]; rows];
        {
            let mut outs: Vec<&mut [u8]> = a.iter_mut().map(|v| v.as_mut_slice()).collect();
            matmul(Kernel::Scalar, &coeffs, &ins, &mut outs);
        }
        {
            let mut outs: Vec<&mut [u8]> = b.iter_mut().map(|v| v.as_mut_slice()).collect();
            matmul(Kernel::best(), &coeffs, &ins, &mut outs);
        }
        assert_eq!(a, b);
        let mut c = vec![vec![0u8; len]; rows];
        {
            let mut outs: Vec<&mut [u8]> = c.iter_mut().map(|v| v.as_mut_slice()).collect();
            matmul_parallel(Kernel::best(), &coeffs, &ins, &mut outs, 4);
        }
        assert_eq!(a, c);
    }
}
