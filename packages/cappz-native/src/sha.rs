//! SHA-256 (FIPS 180-4). On AArch64 the compression function uses the ARMv8
//! Cryptography Extension (SHA256H/H2/SU0/SU1) when the CPU reports it;
//! otherwise, and on wasm32, a portable implementation runs. Content hashing
//! is over public bytes, so no constant-time requirement applies.

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const H0: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Portable,
    #[cfg(target_arch = "aarch64")]
    ArmV8,
}

impl Engine {
    pub fn best() -> Engine {
        #[cfg(target_arch = "aarch64")]
        {
            if std::arch::is_aarch64_feature_detected!("sha2") {
                return Engine::ArmV8;
            }
        }
        Engine::Portable
    }

    pub fn name(self) -> &'static str {
        match self {
            Engine::Portable => "portable",
            #[cfg(target_arch = "aarch64")]
            Engine::ArmV8 => "armv8-sha2",
        }
    }
}

fn compress_portable(state: &mut [u32; 8], blocks: &[u8]) {
    let mut w = [0u32; 64];
    for block in blocks.chunks_exact(64) {
        for t in 0..16 {
            w[t] = u32::from_be_bytes([block[4 * t], block[4 * t + 1], block[4 * t + 2], block[4 * t + 3]]);
        }
        for t in 16..64 {
            let s0 = w[t - 15].rotate_right(7) ^ w[t - 15].rotate_right(18) ^ (w[t - 15] >> 3);
            let s1 = w[t - 2].rotate_right(17) ^ w[t - 2].rotate_right(19) ^ (w[t - 2] >> 10);
            w[t] = w[t - 16].wrapping_add(s0).wrapping_add(w[t - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
        for t in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[t]).wrapping_add(w[t]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (s, v) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *s = s.wrapping_add(v);
        }
    }
}

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon,sha2")]
unsafe fn compress_armv8(state: &mut [u32; 8], blocks: &[u8]) {
    use core::arch::aarch64::*;
    let mut abcd = vld1q_u32(state.as_ptr());
    let mut efgh = vld1q_u32(state.as_ptr().add(4));
    let kp = K.as_ptr();
    for block in blocks.chunks_exact(64) {
        let abcd_save = abcd;
        let efgh_save = efgh;
        let p = block.as_ptr();
        let mut m0 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p)));
        let mut m1 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p.add(16))));
        let mut m2 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p.add(32))));
        let mut m3 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p.add(48))));

        // Four rounds per step; message schedule extended in lockstep.
        macro_rules! rounds {
            ($m:expr, $ki:expr) => {{
                let wk = vaddq_u32($m, vld1q_u32(kp.add($ki)));
                let e0 = abcd;
                abcd = vsha256hq_u32(abcd, efgh, wk);
                efgh = vsha256h2q_u32(efgh, e0, wk);
            }};
        }
        for q in 0..3 {
            let base = q * 16;
            rounds!(m0, base);
            m0 = vsha256su1q_u32(vsha256su0q_u32(m0, m1), m2, m3);
            rounds!(m1, base + 4);
            m1 = vsha256su1q_u32(vsha256su0q_u32(m1, m2), m3, m0);
            rounds!(m2, base + 8);
            m2 = vsha256su1q_u32(vsha256su0q_u32(m2, m3), m0, m1);
            rounds!(m3, base + 12);
            m3 = vsha256su1q_u32(vsha256su0q_u32(m3, m0), m1, m2);
        }
        rounds!(m0, 48);
        rounds!(m1, 52);
        rounds!(m2, 56);
        rounds!(m3, 60);

        abcd = vaddq_u32(abcd, abcd_save);
        efgh = vaddq_u32(efgh, efgh_save);
    }
    vst1q_u32(state.as_mut_ptr(), abcd);
    vst1q_u32(state.as_mut_ptr().add(4), efgh);
}

fn compress(engine: Engine, state: &mut [u32; 8], blocks: &[u8]) {
    match engine {
        Engine::Portable => compress_portable(state, blocks),
        #[cfg(target_arch = "aarch64")]
        Engine::ArmV8 => unsafe { compress_armv8(state, blocks) },
    }
}

/// One-shot SHA-256 of `data`.
pub fn sha256(engine: Engine, data: &[u8]) -> [u8; 32] {
    let mut state = H0;
    let full = data.len() & !63;
    compress(engine, &mut state, &data[..full]);
    let rest = &data[full..];
    let mut tail = [0u8; 128];
    tail[..rest.len()].copy_from_slice(rest);
    tail[rest.len()] = 0x80;
    let tail_len = if rest.len() < 56 { 64 } else { 128 };
    let bits = (data.len() as u64).wrapping_mul(8);
    tail[tail_len - 8..tail_len].copy_from_slice(&bits.to_be_bytes());
    compress(engine, &mut state, &tail[..tail_len]);
    let mut out = [0u8; 32];
    for (i, s) in state.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&s.to_be_bytes());
    }
    out
}

/// SHA-256 of each `chunk`-byte piece of `data` (the last may be shorter),
/// spread over `threads` OS threads. Chunked bodies and model-weight shards
/// are content-addressed per chunk, so the pieces are independent.
#[cfg(not(target_arch = "wasm32"))]
pub fn sha256_chunks(engine: Engine, data: &[u8], chunk: usize, threads: usize) -> Vec<[u8; 32]> {
    assert!(chunk > 0, "chunk must be positive");
    let pieces: Vec<&[u8]> = data.chunks(chunk).collect();
    let mut out = vec![[0u8; 32]; pieces.len()];
    let threads = threads.max(1).min(pieces.len().max(1));
    if threads == 1 {
        for (o, p) in out.iter_mut().zip(&pieces) {
            *o = sha256(engine, p);
        }
        return out;
    }
    // Interleave chunks over threads by index so uneven tails balance out.
    let per = pieces.len().div_ceil(threads);
    std::thread::scope(|s| {
        for (outs, ins) in out.chunks_mut(per).zip(pieces.chunks(per)) {
            s.spawn(move || {
                for (o, p) in outs.iter_mut().zip(ins) {
                    *o = sha256(engine, p);
                }
            });
        }
    });
    out
}

/// Incremental SHA-256 for inputs that arrive in pieces (a file read slice by
/// slice). The digest equals `sha256` over the concatenated pieces.
#[derive(Clone)]
pub struct Sha256 {
    engine: Engine,
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total: u64,
}

impl Sha256 {
    pub fn new(engine: Engine) -> Self {
        Sha256 { engine, state: H0, buf: [0; 64], buf_len: 0, total: 0 }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.wrapping_add(data.len() as u64);
        if self.buf_len > 0 {
            let take = (64 - self.buf_len).min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len < 64 {
                return;
            }
            let block = self.buf;
            compress(self.engine, &mut self.state, &block);
            self.buf_len = 0;
        }
        let full = data.len() & !63;
        compress(self.engine, &mut self.state, &data[..full]);
        let rest = &data[full..];
        self.buf[..rest.len()].copy_from_slice(rest);
        self.buf_len = rest.len();
    }

    pub fn finalize(mut self) -> [u8; 32] {
        let bits = self.total.wrapping_mul(8);
        let mut tail = [0u8; 128];
        tail[..self.buf_len].copy_from_slice(&self.buf[..self.buf_len]);
        tail[self.buf_len] = 0x80;
        let tail_len = if self.buf_len < 56 { 64 } else { 128 };
        tail[tail_len - 8..tail_len].copy_from_slice(&bits.to_be_bytes());
        compress(self.engine, &mut self.state, &tail[..tail_len]);
        let mut out = [0u8; 32];
        for (i, s) in self.state.iter().enumerate() {
            out[4 * i..4 * i + 4].copy_from_slice(&s.to_be_bytes());
        }
        out
    }

    /// Bytes of the portable serialised form (`save` / `load`), which lets a
    /// caller across the C ABI or in WebAssembly memory own the state.
    pub const SAVED_BYTES: usize = 112;
    const MAGIC: [u8; 4] = *b"S256";

    /// Layout: magic[4] · state u32 LE x8 · total u64 LE · buf[64] · buf_len u8 · pad[3].
    pub fn save(&self, out: &mut [u8; Self::SAVED_BYTES]) {
        out.fill(0);
        out[..4].copy_from_slice(&Self::MAGIC);
        for (i, w) in self.state.iter().enumerate() {
            out[4 + 4 * i..8 + 4 * i].copy_from_slice(&w.to_le_bytes());
        }
        out[36..44].copy_from_slice(&self.total.to_le_bytes());
        out[44..108].copy_from_slice(&self.buf);
        out[108] = self.buf_len as u8;
    }

    /// Restore a saved state; `None` when the bytes are not one (wrong tag,
    /// impossible buffer length, or a total that disagrees with the buffer).
    pub fn load(engine: Engine, saved: &[u8; Self::SAVED_BYTES]) -> Option<Self> {
        if saved[..4] != Self::MAGIC {
            return None;
        }
        let buf_len = saved[108] as usize;
        let total = u64::from_le_bytes(saved[36..44].try_into().ok()?);
        if buf_len >= 64 || total % 64 != buf_len as u64 {
            return None;
        }
        let mut state = [0u32; 8];
        for (i, w) in state.iter_mut().enumerate() {
            *w = u32::from_le_bytes(saved[4 + 4 * i..8 + 4 * i].try_into().ok()?);
        }
        let mut buf = [0u8; 64];
        buf.copy_from_slice(&saved[44..108]);
        Some(Sha256 { engine, state, buf, buf_len, total })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    const VECTORS: &[(&str, &str)] = &[
        ("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        ("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
        (
            "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        ),
    ];

    #[test]
    fn known_vectors() {
        for engine in [Engine::Portable, Engine::best()] {
            for (input, want) in VECTORS {
                assert_eq!(hex(&sha256(engine, input.as_bytes())), *want, "{}", engine.name());
            }
            let million_a = vec![b'a'; 1_000_000];
            assert_eq!(
                hex(&sha256(engine, &million_a)),
                "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
            );
        }
    }

    #[test]
    fn engines_agree_on_every_length() {
        let data: Vec<u8> = (0..300u32).map(|i| (i * 131 % 256) as u8).collect();
        for n in 0..data.len() {
            assert_eq!(sha256(Engine::Portable, &data[..n]), sha256(Engine::best(), &data[..n]), "len {n}");
        }
    }

    #[test]
    fn chunks_match_serial() {
        let data: Vec<u8> = (0..1_000_003u32).map(|i| (i * 7 % 256) as u8).collect();
        let par = sha256_chunks(Engine::best(), &data, 65_536, 4);
        let ser: Vec<[u8; 32]> = data.chunks(65_536).map(|c| sha256(Engine::Portable, c)).collect();
        assert_eq!(par, ser);
    }

    #[test]
    fn streaming_matches_one_shot_for_any_split() {
        let data: Vec<u8> = (0..5_000u32).map(|i| (i * 89 % 256) as u8).collect();
        let want = sha256(Engine::Portable, &data);
        for engine in [Engine::Portable, Engine::best()] {
            for split in [0usize, 1, 55, 63, 64, 65, 127, 128, 1000, 4999, 5000] {
                let mut h = Sha256::new(engine);
                h.update(&data[..split]);
                h.update(&[]);
                h.update(&data[split..]);
                assert_eq!(h.finalize(), want, "{} split {split}", engine.name());
            }
            // many tiny pieces
            let mut h = Sha256::new(engine);
            for c in data.chunks(7) {
                h.update(c);
            }
            assert_eq!(h.finalize(), want);
        }
    }

    #[test]
    fn saved_state_round_trips_and_rejects_garbage() {
        let data: Vec<u8> = (0..1000u32).map(|i| i as u8).collect();
        let mut h = Sha256::new(Engine::best());
        h.update(&data[..333]);
        let mut saved = [0u8; Sha256::SAVED_BYTES];
        h.save(&mut saved);
        let mut back = Sha256::load(Engine::best(), &saved).expect("valid state");
        back.update(&data[333..]);
        assert_eq!(back.finalize(), sha256(Engine::Portable, &data));

        let mut bad = saved;
        bad[0] ^= 1;
        assert!(Sha256::load(Engine::best(), &bad).is_none(), "wrong tag");
        let mut bad = saved;
        bad[108] = 64;
        assert!(Sha256::load(Engine::best(), &bad).is_none(), "buffer length out of range");
        let mut bad = saved;
        bad[36] ^= 1;
        assert!(Sha256::load(Engine::best(), &bad).is_none(), "total disagrees with buffer");
    }
}
