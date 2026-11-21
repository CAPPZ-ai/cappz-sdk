// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string>;
};
const BIN_PACKAGE: Record<string, string> = { tsc: 'typescript' };
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

describe('dependency contract', () => {
  it('every tool a package script runs is a declared dependency, not a transitive one', () => {
    // vitest 5 stopped carrying vite-node and esbuild; market:build, mesh and the benches broke silently.
    const declared = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]);
    const tools = new Set(Object.values(pkg.scripts).flatMap((s) => s.split(/&&|\|\|/).map((c) => c.trim().split(/\s+/)[0]).filter((t) => t && t !== 'node').map((t) => BIN_PACKAGE[t] ?? t)));
    expect([...tools].filter((t) => !declared.has(t))).toEqual([]);
    expect(declared.has('esbuild')).toBe(true); // imported by packages/cappz-market/build.mjs and the mesh kit
  });

  it('curve outputs are fixed: a library upgrade never changes a key, signature or shared secret', () => {
    const sk = new Uint8Array(32).fill(7), d = new Uint8Array(32).fill(3), msg = new TextEncoder().encode('cappz vector');
    // Values produced by @noble/curves 1.9.7 and confirmed byte-identical under 2.4.0.
    expect(hex(ed25519.getPublicKey(sk))).toBe('ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c');
    const sig = ed25519.sign(msg, sk);
    expect(hex(sig)).toBe('5f17ac9ce714a103b52c68e78211b762c556e021f39a400e1cdf073725112df9e3e97f504226d6e4996a56582f294cf02306df22f9f47bed851aa5170739180b');
    expect(ed25519.verify(sig, msg, ed25519.getPublicKey(sk), { zip215: false })).toBe(true);
    const bad = sig.slice(); bad[0] ^= 1;
    expect(ed25519.verify(bad, msg, ed25519.getPublicKey(sk))).toBe(false);
    expect(hex(x25519.getSharedSecret(sk, x25519.getPublicKey(d)))).toBe('1d2295e4fbd2b98d28bc11393db3a51fc1773c6d39a71c30b630b3f515369609');
    const uncompressed = p256.getPublicKey(d, false);
    expect(hex(uncompressed)).toBe('04591ab771ebbcfd6d9cb9094d106528add1a69d44c2c1f627f089ec58b9c61adf9f4e6abf0d045c0c693a3c68ad7c97ca72be64def4a26fecd263dd98a92780f0');
    expect(hex(p256.Point.fromHex(hex(p256.getPublicKey(d, true))).toBytes(false))).toBe(hex(uncompressed));
    const offCurve = uncompressed.slice(); offCurve[64] ^= 1;
    expect(() => p256.Point.fromBytes(offCurve).assertValidity()).toThrow();
  });
});
