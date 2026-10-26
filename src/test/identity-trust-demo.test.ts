/** v15-10-00 — the tutorial's demo is the validation: every step, good and bad paths, must pass. */
import { describe, it, expect } from 'vitest';
import { runIdentityTrustDemo, DEFAULT_DEMO_ASSUMPTIONS } from '../lib/identity/identityTrustDemo';

describe('identity and trust demo (/tutorials/identity-and-trust)', () => {
  it('runs end to end with every expectation met, priced from the sheets', async () => {
    const seen: string[] = [];
    const r = await runIdentityTrustDemo({ onStep: (s) => seen.push(s.id), perfIterations: 60 });
    for (const s of r.steps) expect(s.ok, `${s.id}: expected ${s.expect}; got ${s.got}`).toBe(true);
    expect(r.allPassed).toBe(true);
    expect(seen).toEqual(['claims', 'binding', 'attest', 'request', 'disclose', 'verify', 'replay', 'revoke-attestation', 'declare-key', 'revoke-key', 'mtls', 'legacy-drop', 'x509', 'measure']);
    expect(r.comparison?.tradeoffs.some((t) => t.edge === 'x509')).toBe(true);
    const e = r.economics(DEFAULT_DEMO_ASSUMPTIONS);
    expect(e.lines.find((l) => l.source === 'assumption')).toBeTruthy();
    expect(e.perCustomerUsd).toBeLessThan(e.perCustomerTodayUsd);
    expect(e.monthlySavedUsd).toBeGreaterThan(0);
    // No step evidence may carry a claim value.
    expect(JSON.stringify(r.steps.map((s) => s.evidence))).not.toMatch(/Ada|X1234567|1815/);
  }, 60_000);
});
