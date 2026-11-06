/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-verbs.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Governed marketplace command verbs (metadata in commandMetadata.ts, BPMN
 * bindings in src/bpmn/marketplace). The same verbs serve people in the UI,
 * the embedded agent, and autonomous agents (NHCs) through agentApi.ts.
 */
export const MARKETPLACE_VERBS = [
  'marketplace.party.profile',
  'marketplace.listing.publish', 'marketplace.listing.withdraw', 'marketplace.listing.remove', 'marketplace.inventory.adjust',
  'marketplace.order.place', 'marketplace.contract.subcontract',
  'marketplace.request.post', 'marketplace.request.close',
  'marketplace.offer.submit', 'marketplace.offer.withdraw', 'marketplace.offer.award',
  'marketplace.escrow.fund', 'marketplace.milestone.evidence', 'marketplace.access.deliver', 'marketplace.milestone.affirm', 'marketplace.escrow.release', 'marketplace.escrow.refund', 'marketplace.escrow.ledger-settle', 'marketplace.escrow.expire',
  'marketplace.stage.pay',
  'marketplace.channel.open', 'marketplace.channel.settle', 'marketplace.channel.close',
  'marketplace.delivery.accept', 'marketplace.delivery.reject',
  'marketplace.dispute.raise', 'marketplace.dispute.resolve',
  'marketplace.review.post',
  'marketplace.asset.tokenize', 'marketplace.token.transfer', 'marketplace.token.redeem',
  'marketplace.mandate.grant', 'marketplace.mandate.revoke',
  'marketplace.discovery.run',
  'marketplace.settlement.network', 'marketplace.fees.configure', 'marketplace.fees.distribute',
  'marketplace.compliance.eligibility', 'marketplace.security.declare', 'marketplace.security.approve', 'marketplace.security.subscribe', 'marketplace.security.allocate', 'marketplace.security.transfer',
] as const;
export type MarketplaceVerb = typeof MARKETPLACE_VERBS[number];
