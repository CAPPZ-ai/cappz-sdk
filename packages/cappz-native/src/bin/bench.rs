//! Kernel benchmark: Rust vs C++ (with `--features cpp`) vs the RustCrypto
//! sha2 crate (with `--features sha2-crate`), in one process with no binding
//! overhead. Every backend's output is checked against the portable Rust path
//! before it is timed. Prints a table, then one JSON line per result.
//!
//!   cargo run --release --bin bench --features cpp,sha2-crate

use cappz_native::{gf, sha, sig};
use std::hint::black_box;
use std::time::Instant;

#[cfg(feature = "cpp")]
extern "C" {
    fn cpp_gf_matmul(coeffs: *const u8, rows: u32, k: u32, inputs: *const u8, outputs: *mut u8, len: usize) -> i32;
    fn cpp_sha256(data: *const u8, len: usize, out: *mut u8) -> i32;
}

const RUNS: usize = 15;

struct Row {
    group: &'static str,
    name: String,
    mb_s: f64,
    median_ms: f64,
}

/// Median wall time of `RUNS` runs after one warmup, in milliseconds.
fn time<F: FnMut()>(mut f: F) -> f64 {
    f();
    let mut v: Vec<f64> = (0..RUNS)
        .map(|_| {
            let t = Instant::now();
            f();
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[RUNS / 2]
}

fn fill(n: usize, seed: u32) -> Vec<u8> {
    let mut x = seed.wrapping_mul(2654435761).wrapping_add(1);
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}

fn gf_case(rows_out: &mut Vec<Row>, k: usize, m: usize, len: usize, threads: usize) {
    let data = fill(k * len, 7);
    let coeffs: Vec<u8> = (0..m * k).map(|i| gf::EXP[(i * 13 + 1) % 255]).collect();
    let ins: Vec<&[u8]> = data.chunks_exact(len).collect();
    let mb = (k * len) as f64 / (1 << 20) as f64;
    let group: &'static str = Box::leak(format!("rs-encode k={k} m={m} shard={}KiB", len / 1024).into_boxed_str());

    let run = |kernel: gf::Kernel, threads: usize, out: &mut Vec<u8>| {
        let mut outs: Vec<&mut [u8]> = out.chunks_exact_mut(len).collect();
        if threads > 1 {
            gf::matmul_parallel(kernel, &coeffs, &ins, &mut outs, threads);
        } else {
            gf::matmul(kernel, &coeffs, &ins, &mut outs);
        }
    };

    let mut reference = vec![0u8; m * len];
    run(gf::Kernel::Scalar, 1, &mut reference);

    let mut out = vec![0u8; m * len];
    let mut cases: Vec<(String, gf::Kernel, usize)> = vec![("rust scalar".into(), gf::Kernel::Scalar, 1)];
    #[cfg(target_arch = "aarch64")]
    {
        cases.push(("rust neon".into(), gf::Kernel::Neon, 1));
        cases.push((format!("rust neon x{threads} threads"), gf::Kernel::Neon, threads));
    }
    for (name, kernel, t) in cases {
        out.fill(0xAA);
        run(kernel, t, &mut out);
        assert_eq!(out, reference, "{name} disagrees with scalar");
        let ms = time(|| run(kernel, t, black_box(&mut out)));
        rows_out.push(Row { group, name, mb_s: mb / (ms / 1e3), median_ms: ms });
    }

    #[cfg(feature = "cpp")]
    {
        let cxx = std::env::var("CPP_LABEL").unwrap_or_else(|_| "cpp".into());
        let call = |out: &mut Vec<u8>| unsafe {
            cpp_gf_matmul(coeffs.as_ptr(), m as u32, k as u32, data.as_ptr(), out.as_mut_ptr(), len);
        };
        out.fill(0xAA);
        call(&mut out);
        assert_eq!(out, reference, "C++ disagrees with scalar");
        let ms = time(|| call(black_box(&mut out)));
        rows_out.push(Row { group, name: format!("{cxx} neon"), mb_s: mb / (ms / 1e3), median_ms: ms });
    }
}

fn sha_case(rows_out: &mut Vec<Row>, size: usize, threads: usize) {
    let data = fill(size, 3);
    let reference = sha::sha256(sha::Engine::Portable, &data);
    let mb = size as f64 / (1 << 20) as f64;
    let group: &'static str = Box::leak(format!("sha256 {}", human(size)).into_boxed_str());
    let reps = (64 << 20) / size.max(1); // ~64 MiB hashed per timing sample
    let reps = reps.clamp(1, 1 << 20);
    let mut push = |name: String, ms: f64| {
        let per = ms / reps as f64;
        rows_out.push(Row { group, name, mb_s: mb / (per / 1e3), median_ms: per });
    };

    let mut engines = vec![sha::Engine::Portable, sha::Engine::best()];
    engines.dedup();
    for engine in engines {
        assert_eq!(sha::sha256(engine, &data), reference);
        let ms = time(|| for _ in 0..reps { black_box(sha::sha256(engine, black_box(&data))); });
        push(format!("rust {}", engine.name()), ms);
    }

    #[cfg(feature = "cpp")]
    {
        let cxx = std::env::var("CPP_LABEL").unwrap_or_else(|_| "cpp".into());
        let mut d = [0u8; 32];
        unsafe { cpp_sha256(data.as_ptr(), data.len(), d.as_mut_ptr()) };
        assert_eq!(d, reference, "C++ sha256 disagrees");
        let ms = time(|| for _ in 0..reps { unsafe { cpp_sha256(black_box(data.as_ptr()), data.len(), d.as_mut_ptr()) }; });
        push(format!("{cxx} armv8-sha2"), ms);
    }

    #[cfg(feature = "sha2-crate")]
    {
        use sha2::Digest;
        assert_eq!(<[u8; 32]>::from(sha2::Sha256::digest(&data)), reference);
        let ms = time(|| for _ in 0..reps { black_box(sha2::Sha256::digest(black_box(&data))); });
        push("sha2 crate 0.10".into(), ms);
    }

    if size >= 16 << 20 {
        let chunk = 1 << 20;
        let ser = sha::sha256_chunks(sha::Engine::Portable, &data, chunk, 1);
        assert_eq!(sha::sha256_chunks(sha::Engine::best(), &data, chunk, threads), ser);
        let g: &'static str = Box::leak(format!("sha256 chunks of 1MiB over {}", human(size)).into_boxed_str());
        for t in [1, threads] {
            let ms = time(|| { black_box(sha::sha256_chunks(sha::Engine::best(), black_box(&data), chunk, t)); });
            rows_out.push(Row { group: g, name: format!("rust {} x{t} threads", sha::Engine::best().name()), mb_s: mb / (ms / 1e3), median_ms: ms });
        }
    }
}

fn human(n: usize) -> String {
    if n >= 1 << 20 { format!("{}MiB", n >> 20) } else if n >= 1024 { format!("{}KiB", n >> 10) } else { format!("{n}B") }
}

/// Signature verification: µs per signature, single core and all cores.
fn sig_case(rows_out: &mut Vec<Row>, threads: usize) {
    use ed25519_dalek::{Signer, SigningKey as EdSigningKey};
    use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
    const N: usize = 512;
    let mut ec = Vec::with_capacity(N);
    let mut ed = Vec::with_capacity(N);
    for i in 0..N {
        let mut seed = [0u8; 32];
        seed[..8].copy_from_slice(&(i as u64 + 1).to_le_bytes());
        seed[31] = 1;
        let sk = SigningKey::from_slice(&seed).unwrap();
        let digest = sha::sha256(sha::Engine::best(), &seed);
        let s: Signature = sk.sign_prehash(&digest).unwrap();
        let compact: [u8; 64] = s.normalize_s().to_bytes().into();
        let pk = sk.verifying_key().to_sec1_point(true).as_bytes().to_vec();
        ec.push((digest, compact, pk));
        let esk = EdSigningKey::from_bytes(&seed);
        let msg = format!("{{\"kind\":\"hello\",\"n\":{i}}}").into_bytes();
        let esig = esk.sign(&msg).to_bytes();
        ed.push((esk.verifying_key().to_bytes(), esig, msg));
    }
    assert!(ec.iter().all(|(d, s, k)| sig::secp256k1_verify(d, s, k)));
    assert!(ed.iter().all(|(k, s, m)| sig::ed25519_verify(k, s, m)));
    let us_per = |ms: f64| ms * 1e3 / N as f64;
    let mut push = |group: &'static str, name: String, ms: f64| rows_out.push(Row { group, name, mb_s: N as f64 / (ms / 1e3), median_ms: us_per(ms) / 1e3 });

    let g_ec = "secp256k1 ECDSA verify (low-S), 512 signatures";
    let ms = time(|| { black_box(sig::verify_many(N, 1, |i| sig::secp256k1_verify(&ec[i].0, &ec[i].1, &ec[i].2))); });
    push(g_ec, "rust k256".into(), ms);
    let ms = time(|| { black_box(sig::verify_many(N, threads, |i| sig::secp256k1_verify(&ec[i].0, &ec[i].1, &ec[i].2))); });
    push(g_ec, format!("rust k256 x{threads} threads"), ms);
    #[cfg(feature = "c-secp256k1")]
    #[allow(deprecated)] // verify_ecdsa: the stable spelling across secp256k1 releases
    {
        use secp256k1::{ecdsa::Signature as CSig, Message, PublicKey, Secp256k1};
        let ctx = Secp256k1::verification_only();
        let prepared: Vec<(Message, CSig, PublicKey)> = ec.iter().map(|(d, s, k)| (Message::from_digest(*d), CSig::from_compact(s).unwrap(), PublicKey::from_slice(k).unwrap())).collect();
        assert!(prepared.iter().all(|(m, s, k)| ctx.verify_ecdsa(*m, s, k).is_ok()));
        let ms = time(|| { for (d, s, k) in &ec { let m = Message::from_digest(*d); let s = CSig::from_compact(s).unwrap(); let k = PublicKey::from_slice(k).unwrap(); black_box(ctx.verify_ecdsa(m, &s, &k).is_ok()); } });
        push(g_ec, "c libsecp256k1".into(), ms);
    }

    let g_ed = "Ed25519 verify (strict), 512 signatures";
    let ms = time(|| { black_box(sig::verify_many(N, 1, |i| sig::ed25519_verify(&ed[i].0, &ed[i].1, &ed[i].2))); });
    push(g_ed, "rust ed25519-dalek".into(), ms);
    let ms = time(|| { black_box(sig::verify_many(N, threads, |i| sig::ed25519_verify(&ed[i].0, &ed[i].1, &ed[i].2))); });
    push(g_ed, format!("rust ed25519-dalek x{threads} threads"), ms);
}

fn main() {
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    let mut rows = Vec::new();
    sig_case(&mut rows, threads);
    gf_case(&mut rows, 10, 4, 1 << 20, threads);
    gf_case(&mut rows, 10, 4, 64 << 10, threads);
    gf_case(&mut rows, 4, 2, 4 << 20, threads);
    for size in [64usize, 1024, 64 << 10, 64 << 20] {
        sha_case(&mut rows, size, threads);
    }

    println!("cappz-native bench · {} · {} threads · features {:#b}", std::env::consts::ARCH, threads, cappz_native::cappz_native_features());
    let mut last = "";
    for r in &rows {
        if r.group != last {
            println!("\n{}", r.group);
            last = r.group;
        }
        if r.group.contains("verify") {
            println!("  {:<34} {:>9.0} /s     {:>9.1} µs", r.name, r.mb_s, r.median_ms * 1e3);
            continue;
        }
        let lat = if r.median_ms < 0.01 { format!("{:.0} ns", r.median_ms * 1e6) } else { format!("{:.3} ms", r.median_ms) };
        println!("  {:<34} {:>9.0} MB/s   {:>12}", r.name, r.mb_s, lat);
    }
    println!();
    for r in &rows {
        println!("{{\"group\":\"{}\",\"name\":\"{}\",\"mb_s\":{:.1},\"median_ms\":{:.6}}}", r.group, r.name, r.mb_s, r.median_ms);
    }
}
