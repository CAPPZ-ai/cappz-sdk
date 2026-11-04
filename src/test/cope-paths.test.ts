import { describe, expect, it } from 'vitest';
import { capabilityPath, COPE_LEARNING_LOG, COPE_ROOT, copeAlias, copeNodePath, LEGACY_COPE_PREFIX, providerSegmentsIn } from '../lib/wallets/paths';
import { isSubstrateAuthor, SUBSTRATE_AUTHOR } from '../lib/governance/PrinciplesChainlet';

describe('CAPPZ-rooted COPE nodes and capabilities', () => {
  it('COPE nodes sit beside the COPE substrate, under the principles account', () => {
    expect(COPE_ROOT).toBe("m/44'/144'/100'/cope");
    expect(copeNodePath('Architectural design guide', '2026-10-23')).toBe("m/44'/144'/100'/cope/architectural-design-guide/2026-10-23");
    expect(() => copeNodePath('x', '23/10/2026')).toThrow(/YYYY-MM-DD/);
    expect(COPE_LEARNING_LOG).toBe("m/44'/144'/100'/cope/learning/event-log");
    expect(capabilityPath('EBB escrow')).toBe("m/44'/144'/0'/cappz/capabilities/ebb-escrow");
  });

  it('the old documented provider-rooted prefix resolves read-only to the CAPPZ root', () => {
    expect(copeAlias(`${LEGACY_COPE_PREFIX}/architectural-design-guide/2026-10-23`)).toBe(copeNodePath('architectural-design-guide', '2026-10-23'));
    expect(copeAlias("m/44'/144'/0'/cappz/skills/x")).toBe("m/44'/144'/0'/cappz/skills/x");
  });

  it('finds provider names as words in any segment, and nothing in CAPPZ addresses', () => {
    expect(providerSegmentsIn(`${LEGACY_COPE_PREFIX}/x`)).toEqual(['lovable']);
    expect(providerSegmentsIn("m/44'/144'/0'/cappz/skills/stripe-xrp-bridge")).toEqual(['stripe']);
    expect(providerSegmentsIn(copeNodePath('agent learning', '2026-11-03'))).toEqual([]);
    expect(providerSegmentsIn("m/44'/144'/0'/cappz/skills/googleplex")).toEqual([]);
  });

  it('substrate adoptions are authored by CAPPZ; earlier records keep their author as an alias', () => {
    expect(SUBSTRATE_AUTHOR).toBe('cappz-build-agent');
    expect(isSubstrateAuthor('lovable-agent')).toBe(true);
    expect(isSubstrateAuthor('someone')).toBe(false);
  });
});
