// C++ twins of the Rust kernels (src/gf.rs, src/sha.rs): same algorithm, tile
// size and unroll, so `bench` compares languages and compilers rather than
// designs. Built only with `--features cpp`; the shipped library is Rust.
#include <arm_neon.h>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace {

constexpr std::size_t kTile = 16 * 1024;

struct GfTables {
  std::uint8_t exp[512];
  std::uint8_t log[256];
  GfTables() {
    unsigned x = 1;
    for (int i = 0; i < 255; ++i) {
      exp[i] = static_cast<std::uint8_t>(x);
      log[x] = static_cast<std::uint8_t>(i);
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (int i = 255; i < 512; ++i) exp[i] = exp[i - 255];
    log[0] = 0;
  }
};
const GfTables kGf;

inline std::uint8_t gf_mul(std::uint8_t a, std::uint8_t b) {
  return (a == 0 || b == 0) ? 0 : kGf.exp[kGf.log[a] + kGf.log[b]];
}

void mul_slice_scalar(std::uint8_t c, const std::uint8_t* in, std::uint8_t* out, std::size_t n, bool assign) {
  std::uint8_t row[256];
  for (int x = 0; x < 256; ++x) row[x] = gf_mul(c, static_cast<std::uint8_t>(x));
  if (assign) for (std::size_t i = 0; i < n; ++i) out[i] = row[in[i]];
  else for (std::size_t i = 0; i < n; ++i) out[i] ^= row[in[i]];
}

void mul_slice_neon(std::uint8_t c, const std::uint8_t* in, std::uint8_t* out, std::size_t n, bool assign) {
  std::uint8_t lo[16], hi[16];
  for (int i = 0; i < 16; ++i) {
    lo[i] = gf_mul(c, static_cast<std::uint8_t>(i));
    hi[i] = gf_mul(c, static_cast<std::uint8_t>(i << 4));
  }
  const uint8x16_t tlo = vld1q_u8(lo), thi = vld1q_u8(hi), mask = vdupq_n_u8(0x0f);
  std::size_t i = 0;
  for (; i + 64 <= n; i += 64) {
    uint8x16_t x0 = vld1q_u8(in + i), x1 = vld1q_u8(in + i + 16), x2 = vld1q_u8(in + i + 32), x3 = vld1q_u8(in + i + 48);
    uint8x16_t p0 = veorq_u8(vqtbl1q_u8(tlo, vandq_u8(x0, mask)), vqtbl1q_u8(thi, vshrq_n_u8(x0, 4)));
    uint8x16_t p1 = veorq_u8(vqtbl1q_u8(tlo, vandq_u8(x1, mask)), vqtbl1q_u8(thi, vshrq_n_u8(x1, 4)));
    uint8x16_t p2 = veorq_u8(vqtbl1q_u8(tlo, vandq_u8(x2, mask)), vqtbl1q_u8(thi, vshrq_n_u8(x2, 4)));
    uint8x16_t p3 = veorq_u8(vqtbl1q_u8(tlo, vandq_u8(x3, mask)), vqtbl1q_u8(thi, vshrq_n_u8(x3, 4)));
    if (assign) {
      vst1q_u8(out + i, p0); vst1q_u8(out + i + 16, p1); vst1q_u8(out + i + 32, p2); vst1q_u8(out + i + 48, p3);
    } else {
      vst1q_u8(out + i, veorq_u8(vld1q_u8(out + i), p0));
      vst1q_u8(out + i + 16, veorq_u8(vld1q_u8(out + i + 16), p1));
      vst1q_u8(out + i + 32, veorq_u8(vld1q_u8(out + i + 32), p2));
      vst1q_u8(out + i + 48, veorq_u8(vld1q_u8(out + i + 48), p3));
    }
  }
  for (; i + 16 <= n; i += 16) {
    uint8x16_t x = vld1q_u8(in + i);
    uint8x16_t p = veorq_u8(vqtbl1q_u8(tlo, vandq_u8(x, mask)), vqtbl1q_u8(thi, vshrq_n_u8(x, 4)));
    vst1q_u8(out + i, assign ? p : veorq_u8(vld1q_u8(out + i), p));
  }
  if (i < n) mul_slice_scalar(c, in + i, out + i, n - i, assign);
}

const std::uint32_t kK[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

void compress_armv8(std::uint32_t state[8], const std::uint8_t* p, std::size_t blocks) {
  uint32x4_t abcd = vld1q_u32(state), efgh = vld1q_u32(state + 4);
  for (; blocks; --blocks, p += 64) {
    const uint32x4_t abcd_save = abcd, efgh_save = efgh;
    uint32x4_t m0 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p)));
    uint32x4_t m1 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p + 16)));
    uint32x4_t m2 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p + 32)));
    uint32x4_t m3 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p + 48)));
    auto rounds = [&](uint32x4_t m, int ki) {
      const uint32x4_t wk = vaddq_u32(m, vld1q_u32(kK + ki));
      const uint32x4_t e0 = abcd;
      abcd = vsha256hq_u32(abcd, efgh, wk);
      efgh = vsha256h2q_u32(efgh, e0, wk);
    };
    for (int q = 0; q < 3; ++q) {
      const int b = q * 16;
      rounds(m0, b);      m0 = vsha256su1q_u32(vsha256su0q_u32(m0, m1), m2, m3);
      rounds(m1, b + 4);  m1 = vsha256su1q_u32(vsha256su0q_u32(m1, m2), m3, m0);
      rounds(m2, b + 8);  m2 = vsha256su1q_u32(vsha256su0q_u32(m2, m3), m0, m1);
      rounds(m3, b + 12); m3 = vsha256su1q_u32(vsha256su0q_u32(m3, m0), m1, m2);
    }
    rounds(m0, 48); rounds(m1, 52); rounds(m2, 56); rounds(m3, 60);
    abcd = vaddq_u32(abcd, abcd_save);
    efgh = vaddq_u32(efgh, efgh_save);
  }
  vst1q_u32(state, abcd);
  vst1q_u32(state + 4, efgh);
}

}  // namespace

extern "C" {

// Same contract as cappz_gf_matmul (single-threaded): shards back to back.
int cpp_gf_matmul(const std::uint8_t* coeffs, std::uint32_t rows, std::uint32_t k, const std::uint8_t* inputs,
                  std::uint8_t* outputs, std::size_t len) {
  for (std::size_t at = 0; at < len; at += kTile) {
    const std::size_t n = (len - at < kTile) ? len - at : kTile;
    for (std::uint32_t r = 0; r < rows; ++r) {
      std::uint8_t* out = outputs + r * len + at;
      bool first = true;
      for (std::uint32_t j = 0; j < k; ++j) {
        const std::uint8_t c = coeffs[r * k + j];
        if (!c) continue;
        mul_slice_neon(c, inputs + j * len + at, out, n, first);
        first = false;
      }
      if (first) std::memset(out, 0, n);
    }
  }
  return 0;
}

int cpp_sha256(const std::uint8_t* data, std::size_t len, std::uint8_t* out) {
  std::uint32_t state[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  const std::size_t full = len & ~static_cast<std::size_t>(63);
  compress_armv8(state, data, full / 64);
  std::uint8_t tail[128] = {0};
  const std::size_t rest = len - full;
  if (rest) std::memcpy(tail, data + full, rest);
  tail[rest] = 0x80;
  const std::size_t tail_len = rest < 56 ? 64 : 128;
  const std::uint64_t bits = static_cast<std::uint64_t>(len) * 8;
  for (int i = 0; i < 8; ++i) tail[tail_len - 1 - i] = static_cast<std::uint8_t>(bits >> (8 * i));
  compress_armv8(state, tail, tail_len / 64);
  for (int i = 0; i < 8; ++i) {
    out[4 * i] = static_cast<std::uint8_t>(state[i] >> 24);
    out[4 * i + 1] = static_cast<std::uint8_t>(state[i] >> 16);
    out[4 * i + 2] = static_cast<std::uint8_t>(state[i] >> 8);
    out[4 * i + 3] = static_cast<std::uint8_t>(state[i]);
  }
  return 0;
}

}  // extern "C"
