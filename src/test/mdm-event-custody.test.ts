import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearEventCustodyDrift,
  createNotarizedEvent,
  resolveEventCustody,
  resolveEventCustodyDrift,
  resolveEventCustodyDriftFromTxs,
} from '../lib/mdm/eventCustody';
import { EBB_EVENT_TYPES, getEventTxRegistryEntry, verifyEventTxRegistration } from '../lib/skills/core/MDMEventTxRegistry';
import { registrationSeedEventType } from '../lib/mdm/eventTypeAliases';

const SUBSTRATE_VOCABULARY = [
  // wallet tiers
  'WalletCopied', 'WalletCloned', 'WalletTemplateRegistered', 'WalletTierTyped',
  'WalletTierRetyped', 'UserPowAnchored', 'VersionPinned', 'VersionUnpinned',
  'DomainModelAmended', 'ContextTurnAppended', 'UserAliasCreated', 'UserAliasAmended',
  // access control
  'SecurityPrincipalCreated', 'ConstituencyInvited', 'ConstituencyInviteAccepted',
  'AllAccessGranted', 'PermissionGranted', 'BpmnGovernanceBound',
  // inference, models, typing, preferences
  'WalletHostDeclared', 'InferenceResidencyChanged', 'ModelArtifactIngested',
  'ModelVersionPublished', 'ModelCacheWarmed', 'TypeCastAssociated', 'TypeCastDisassociated',
  'RuntimeLocationSelected', 'ModelSelected',
];

describe('universal MDM event custody', () => {
  beforeEach(() => clearEventCustodyDrift());

  it('declares the whole emitted vocabulary, EBB and substrate alike', () => {
    expect(verifyEventTxRegistration([...EBB_EVENT_TYPES])).toEqual([]);
    expect(verifyEventTxRegistration(SUBSTRATE_VOCABULARY)).toEqual([]);
  });

  it('binds the declaration address and receipt id into the hash', async () => {
    const event = await createNotarizedEvent({
      txId: 'test:tier:1', timestamp: '2026-09-11T00:00:00.000Z', eventType: 'WalletCloned',
      sourceAddress: 'template', targetAddress: 'clone',
      governingPrinciple: 'AX-74', emitterDomain: 'wallet-tiers',
    });
    expect(event.custodyStatus).toBe('declared');
    // v12-20-06: WalletClonedTx merged into the admin-queue WalletCloned declaration.
    expect(event.eventMdmAddress).toContain('/event-tx-registry/admin-queue/wallet-cloned');
    expect(event.eventRegistrationTxId).toBe('admin-queue:event-type:registered:WalletCloned');
    expect(event.txHash).toMatch(/^[0-9a-f]{64}$/);

    const tampered = await createNotarizedEvent({
      txId: 'test:tier:1', timestamp: '2026-09-11T00:00:00.000Z', eventType: 'WalletCopied',
      sourceAddress: 'template', targetAddress: 'clone',
      governingPrinciple: 'AX-74', emitterDomain: 'wallet-tiers',
    });
    expect(tampered.txHash).not.toBe(event.txHash);
  });

  it('records an undeclared emission instead of throwing', async () => {
    const event = await createNotarizedEvent({
      txId: 'test:unknown:1', eventType: 'SomethingNobodyDeclared',
      sourceAddress: 'a', targetAddress: 'b',
      governingPrinciple: 'AX-88', emitterDomain: 'test-domain',
    });
    expect(event.custodyStatus).toBe('undeclared');
    expect(event.eventMdmAddress).toContain('/undeclared/something-nobody-declared');

    const drift = resolveEventCustodyDrift();
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      eventType: 'SomethingNobodyDeclared',
      emissionCount: 1,
      emitterDomains: ['test-domain'],
    });
  });

  it('refuses an undeclared emission where the vocabulary is closed', async () => {
    await expect(
      createNotarizedEvent({
        txId: 'test:closed', eventType: 'NotARealEvent', sourceAddress: 'a', targetAddress: 'b',
        governingPrinciple: 'AX-88', emitterDomain: 'ebb', enforcement: 'refuse',
      }),
    ).rejects.toThrow(/not MDM-registered/);
  });

  it('reports drift by replaying an arbitrary history', () => {
    const drift = resolveEventCustodyDriftFromTxs([
      { txId: 't1', eventType: 'WalletCloned' },
      { txId: 't2', eventType: 'GhostEvent' },
      { txId: 't3', eventType: 'GhostEvent' },
    ]);
    expect(drift).toEqual([
      { eventType: 'GhostEvent', emissionCount: 2, emitterDomains: ['replay'], sampleTxIds: ['t2', 't3'] },
    ]);
  });

  it('keeps declared custody stable for every EBB type', () => {
    for (const eventType of EBB_EVENT_TYPES) {
      const custody = resolveEventCustody(eventType);
      expect(custody.custodyStatus).toBe('declared');
      const entry = getEventTxRegistryEntry(eventType)!;
      expect(custody.eventRegistrationTxId).toBe(`${entry.category}:event-type:registered:${registrationSeedEventType(eventType)}`);
    }
  });
});
