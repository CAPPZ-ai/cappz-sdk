//! cappz-native: the SDK's compute kernels as one C ABI, loaded natively
//! (Deno.dlopen, bun:ffi, node:ffi) or as WebAssembly in browsers. The
//! TypeScript wrapper is `src/lib/native/cappzNative.ts`; it falls back to
//! TypeScript when no binary is available, so nothing depends on this crate.
//!
//! Every export checks its pointers and lengths and returns a status code
//! instead of panicking across the boundary.

pub mod gf;
pub mod sha;

use core::slice;

pub const OK: i32 = 0;
pub const ERR_NULL: i32 = -1;
pub const ERR_SHAPE: i32 = -2;
pub const ERR_STATE: i32 = -3;

#[cfg(not(target_arch = "wasm32"))]
fn thread_count(requested: u32) -> usize {
    match requested {
        0 => std::thread::available_parallelism().map_or(1, |n| n.get()),
        n => n as usize,
    }
}

/// ABI version; bump on any signature change. 2 added streaming SHA-256 (single and paired).
#[no_mangle]
pub extern "C" fn cappz_native_abi() -> u32 {
    2
}

/// Bit set of the paths this build will take: 1 = NEON / SIMD128 GF kernel,
/// 2 = ARMv8 SHA-256 instructions, 4 = threads available.
#[no_mangle]
pub extern "C" fn cappz_native_features() -> u32 {
    let mut f = 0;
    if gf::Kernel::best() != gf::Kernel::Scalar {
        f |= 1;
    }
    if sha::Engine::best() != sha::Engine::Portable {
        f |= 2;
    }
    if cfg!(not(target_arch = "wasm32")) {
        f |= 4;
    }
    f
}

/// Reed-Solomon kernel over shards laid out back to back:
/// `inputs` holds `k` shards of `len` bytes, `outputs` receives `rows`.
/// `coeffs` is `rows * k`, row-major. `threads` 0 uses every core, 1 stays
/// on the calling thread.
///
/// # Safety
/// The pointers must be valid for the stated sizes and `outputs` must not
/// overlap `inputs` or `coeffs`.
#[no_mangle]
pub unsafe extern "C" fn cappz_gf_matmul(
    coeffs: *const u8,
    rows: u32,
    k: u32,
    inputs: *const u8,
    outputs: *mut u8,
    len: usize,
    threads: u32,
) -> i32 {
    if coeffs.is_null() || inputs.is_null() || outputs.is_null() {
        return ERR_NULL;
    }
    let (rows, k) = (rows as usize, k as usize);
    let (Some(in_bytes), Some(out_bytes)) = (k.checked_mul(len), rows.checked_mul(len)) else {
        return ERR_SHAPE;
    };
    if rows == 0 || k == 0 || rows > 255 || k > 255 {
        return ERR_SHAPE;
    }
    let coeffs = slice::from_raw_parts(coeffs, rows * k);
    let inputs = slice::from_raw_parts(inputs, in_bytes);
    let outputs = slice::from_raw_parts_mut(outputs, out_bytes);
    let ins: Vec<&[u8]> = inputs.chunks_exact(len.max(1)).take(k).collect();
    let mut outs: Vec<&mut [u8]> = outputs.chunks_exact_mut(len.max(1)).take(rows).collect();
    if len == 0 {
        return OK;
    }
    let kernel = gf::Kernel::best();
    #[cfg(not(target_arch = "wasm32"))]
    gf::matmul_parallel(kernel, coeffs, &ins, &mut outs, thread_count(threads));
    #[cfg(target_arch = "wasm32")]
    {
        let _ = threads;
        gf::matmul(kernel, coeffs, &ins, &mut outs);
    }
    OK
}

/// SHA-256 of `len` bytes into the 32 bytes at `out`.
///
/// # Safety
/// `data` must be valid for `len` bytes (or null when `len` is 0) and `out` for 32.
#[no_mangle]
pub unsafe extern "C" fn cappz_sha256(data: *const u8, len: usize, out: *mut u8) -> i32 {
    if out.is_null() || (data.is_null() && len != 0) {
        return ERR_NULL;
    }
    let data = if len == 0 { &[][..] } else { slice::from_raw_parts(data, len) };
    let digest = sha::sha256(sha::Engine::best(), data);
    slice::from_raw_parts_mut(out, 32).copy_from_slice(&digest);
    OK
}

/// SHA-256 of each `chunk`-byte piece of `data`; digests are written back to
/// back into `out`, which must hold `ceil(len / chunk) * 32` bytes. `threads`
/// as for `cappz_gf_matmul`.
///
/// # Safety
/// `data` must be valid for `len` bytes and `out` for the digest count above.
#[no_mangle]
pub unsafe extern "C" fn cappz_sha256_chunks(data: *const u8, len: usize, chunk: usize, out: *mut u8, threads: u32) -> i32 {
    if data.is_null() || out.is_null() {
        return ERR_NULL;
    }
    if chunk == 0 {
        return ERR_SHAPE;
    }
    let data = slice::from_raw_parts(data, len);
    let n = len.div_ceil(chunk);
    let out = slice::from_raw_parts_mut(out, n * 32);
    let engine = sha::Engine::best();
    #[cfg(not(target_arch = "wasm32"))]
    let digests = sha::sha256_chunks(engine, data, chunk, thread_count(threads));
    #[cfg(target_arch = "wasm32")]
    let digests: Vec<[u8; 32]> = {
        let _ = threads;
        data.chunks(chunk).map(|c| sha::sha256(engine, c)).collect()
    };
    for (o, d) in out.chunks_exact_mut(32).zip(&digests) {
        o.copy_from_slice(d);
    }
    OK
}

/// Bytes the caller allocates for one streaming SHA-256 state.
#[no_mangle]
pub extern "C" fn cappz_sha256_state_bytes() -> u32 {
    sha::Sha256::SAVED_BYTES as u32
}

/// Start a streaming SHA-256 in the caller's `cappz_sha256_state_bytes()` bytes.
///
/// # Safety
/// `state` must be valid for `cappz_sha256_state_bytes()` bytes.
#[no_mangle]
pub unsafe extern "C" fn cappz_sha256_begin(state: *mut u8) -> i32 {
    let Some(saved) = state_mut(state) else { return ERR_NULL };
    sha::Sha256::new(sha::Engine::best()).save(saved);
    OK
}

/// Feed `len` bytes into a state from `cappz_sha256_begin`.
///
/// # Safety
/// `state` as for `cappz_sha256_begin`; `data` valid for `len` bytes (or null when `len` is 0).
#[no_mangle]
pub unsafe extern "C" fn cappz_sha256_update(state: *mut u8, data: *const u8, len: usize) -> i32 {
    let Some(saved) = state_mut(state) else { return ERR_NULL };
    if data.is_null() && len != 0 {
        return ERR_NULL;
    }
    let Some(mut h) = sha::Sha256::load(sha::Engine::best(), saved) else { return ERR_STATE };
    if len != 0 {
        h.update(slice::from_raw_parts(data, len));
    }
    h.save(saved);
    OK
}

/// Feed the same `len` bytes into two different states — the content hash and
/// the salted leaf of one file — on two cores when the piece is large enough.
///
/// # Safety
/// `a` and `b` as for `cappz_sha256_begin` and not overlapping; `data` as for `cappz_sha256_update`.
#[no_mangle]
pub unsafe extern "C" fn cappz_sha256_update_pair(a: *mut u8, b: *mut u8, data: *const u8, len: usize) -> i32 {
    if a.is_null() || b.is_null() || (data.is_null() && len != 0) {
        return ERR_NULL;
    }
    let (lo, hi) = if (a as usize) < (b as usize) { (a as usize, b as usize) } else { (b as usize, a as usize) };
    if hi - lo < sha::Sha256::SAVED_BYTES {
        return ERR_STATE; // the same or overlapping states would race
    }
    let (Some(sa), Some(sb)) = (state_mut(a), state_mut(b)) else { return ERR_NULL };
    let engine = sha::Engine::best();
    let (Some(mut ha), Some(mut hb)) = (sha::Sha256::load(engine, sa), sha::Sha256::load(engine, sb)) else { return ERR_STATE };
    let bytes: &[u8] = if len == 0 { &[] } else { slice::from_raw_parts(data, len) };
    #[cfg(not(target_arch = "wasm32"))]
    if len >= 256 * 1024 {
        std::thread::scope(|s| {
            s.spawn(|| hb.update(bytes));
            ha.update(bytes);
        });
    } else {
        ha.update(bytes);
        hb.update(bytes);
    }
    #[cfg(target_arch = "wasm32")]
    {
        ha.update(bytes);
        hb.update(bytes);
    }
    ha.save(sa);
    hb.save(sb);
    OK
}

/// Write the digest to the 32 bytes at `out` and retire the state (it must be
/// begun again before reuse).
///
/// # Safety
/// `state` as for `cappz_sha256_begin`; `out` valid for 32 bytes.
#[no_mangle]
pub unsafe extern "C" fn cappz_sha256_finish(state: *mut u8, out: *mut u8) -> i32 {
    let Some(saved) = state_mut(state) else { return ERR_NULL };
    if out.is_null() {
        return ERR_NULL;
    }
    let Some(h) = sha::Sha256::load(sha::Engine::best(), saved) else { return ERR_STATE };
    slice::from_raw_parts_mut(out, 32).copy_from_slice(&h.finalize());
    saved.fill(0);
    OK
}

unsafe fn state_mut<'a>(state: *mut u8) -> Option<&'a mut [u8; sha::Sha256::SAVED_BYTES]> {
    (!state.is_null()).then(|| &mut *(state as *mut [u8; sha::Sha256::SAVED_BYTES]))
}

// WebAssembly hosts cannot hand the module pointers into their own memory,
// so they allocate inside the module's linear memory first.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cappz_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` must come from one `cappz_alloc` call.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn cappz_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}
