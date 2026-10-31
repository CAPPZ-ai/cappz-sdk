//! Signature verification on audited crates — k256 (RustCrypto) for
//! secp256k1 ECDSA and ed25519-dalek for Ed25519. Nothing here implements
//! curve arithmetic; this module fixes the acceptance rules and spreads
//! batches over cores.
//!
//! secp256k1: ECDSA over a caller-supplied 32-byte digest, compact r||s, and
//! high-S signatures are refused (the SDK's wallet signatures are low-S, and
//! @noble/secp256k1 refuses the high-S twin too).
//!
//! Ed25519: `verify_strict` — non-canonical encodings and small-order keys
//! are refused, so this path never accepts more than a stricter verifier would.

use ed25519_dalek::{Signature as EdSignature, VerifyingKey as EdKey};
use k256::ecdsa::{signature::hazmat::PrehashVerifier, Signature as EcSignature, VerifyingKey as EcKey};

/// ECDSA secp256k1 over `digest` with a 64-byte compact signature; `public_key`
/// is a SEC1 point (33 or 65 bytes). Low-S only.
pub fn secp256k1_verify(digest: &[u8; 32], signature: &[u8; 64], public_key: &[u8]) -> bool {
    let Ok(key) = EcKey::from_sec1_bytes(public_key) else { return false };
    let Ok(sig) = EcSignature::from_slice(signature) else { return false };
    if sig.normalize_s() != sig {
        return false; // high-S
    }
    key.verify_prehash(digest, &sig).is_ok()
}

/// Ed25519 (RFC 8032), strict.
pub fn ed25519_verify(public_key: &[u8; 32], signature: &[u8; 64], message: &[u8]) -> bool {
    let Ok(key) = EdKey::from_bytes(public_key) else { return false };
    let sig = EdSignature::from_bytes(signature);
    key.verify_strict(message, &sig).is_ok()
}

/// Run `check(i)` for i in 0..n, spread over `threads` OS threads; results in order.
#[cfg(not(target_arch = "wasm32"))]
pub fn verify_many<F: Fn(usize) -> bool + Sync>(n: usize, threads: usize, check: F) -> Vec<bool> {
    let threads = threads.max(1).min(n.max(1));
    // A verification is ~50-100 µs, so batches below ~32 items stay on one thread.
    if threads == 1 || n < 32 {
        return (0..n).map(&check).collect();
    }
    let mut out = vec![false; n];
    let per = n.div_ceil(threads);
    std::thread::scope(|s| {
        for (t, chunk) in out.chunks_mut(per).enumerate() {
            let check = &check;
            s.spawn(move || {
                for (j, slot) in chunk.iter_mut().enumerate() {
                    *slot = check(t * per + j);
                }
            });
        }
    });
    out
}

#[cfg(target_arch = "wasm32")]
pub fn verify_many<F: Fn(usize) -> bool>(n: usize, _threads: usize, check: F) -> Vec<bool> {
    (0..n).map(check).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn ed25519_rfc8032_vectors() {
        // RFC 8032 §7.1 TEST 1 (empty message) and TEST 2 (one byte).
        let cases = [
            ("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
             "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
            ("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
             "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
        ];
        for (pk, msg, sig) in cases {
            let pk: [u8; 32] = hex(pk).try_into().unwrap();
            let sig: [u8; 64] = hex(sig).try_into().unwrap();
            let msg = hex(msg);
            assert!(ed25519_verify(&pk, &sig, &msg));
            let mut bad = msg.clone();
            bad.push(0);
            assert!(!ed25519_verify(&pk, &sig, &bad));
            let mut bad_sig = sig;
            bad_sig[10] ^= 1;
            assert!(!ed25519_verify(&pk, &bad_sig, &msg));
        }
        // A small-order public key (the identity) is refused outright.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert!(!ed25519_verify(&identity, &[0u8; 64], b""));
    }

    #[test]
    fn secp256k1_round_trip_and_high_s() {
        use k256::ecdsa::{signature::hazmat::PrehashSigner, SigningKey};
        let sk = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let digest = [42u8; 32];
        let sig: EcSignature = sk.sign_prehash(&digest).unwrap();
        let sig = sig.normalize_s();
        let compact: [u8; 64] = sig.to_bytes().into();
        let point = sk.verifying_key().to_sec1_point(true);
        assert!(secp256k1_verify(&digest, &compact, point.as_bytes()));
        let full = sk.verifying_key().to_sec1_point(false);
        assert!(secp256k1_verify(&digest, &compact, full.as_bytes()));
        assert!(!secp256k1_verify(&[43u8; 32], &compact, point.as_bytes()));
        // The high-S twin (r, n - s) is mathematically valid but refused.
        let n = hex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
        let mut s = [0i32; 32];
        let mut borrow = 0i32;
        for i in (0..32).rev() {
            let v = n[i] as i32 - compact[32 + i] as i32 - borrow;
            borrow = (v < 0) as i32;
            s[i] = (v + 256) % 256;
        }
        let mut high = compact;
        for i in 0..32 { high[32 + i] = s[i] as u8; }
        assert!(!secp256k1_verify(&digest, &high, point.as_bytes()));
        assert!(!secp256k1_verify(&[1; 32], &[0; 64], &[2; 33]));
        assert!(!secp256k1_verify(&[1; 32], &[1; 64], &[0; 10]));
    }

    #[test]
    fn verify_many_keeps_order() {
        let r = verify_many(100, 4, |i| i % 3 == 0);
        assert!(r.iter().enumerate().all(|(i, &v)| v == (i % 3 == 0)));
    }
}
