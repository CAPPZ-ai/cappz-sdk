/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-paths.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * MarketplacePaths — single source of truth for every marketplace HD address (AX-59).
 *
 *   PTW  cappz/templates/marketplace          ← catalog ontology, BPMN, embedded agent template
 *   └── agent
 *   POW  cappz/operational/marketplace        ← the public market (WalletCopied from the PTW)
 *   ├── agent                                  ← shared agent binding
 *   ├── parties/{partyId}                      ← public party profiles (people, companies, agents/NHCs)
 *   ├── listings/{listingId}                   ← standing offers to sell / rent / serve
 *   ├── requests/{requestId}                   ← requests for supply (incl. crops that do not exist yet)
 *   │   └── offers/{offerId}                   ← bids
 *   ├── contracts/{contractId}/                ← composite contract wallet (OTC bilateral)
 *   │   ├── agreement · escrow · milestones/{n} · deliveries/{n} · disputes/{n} · reviews/{partyId}
 *   │   └── subcontracts/{childId}             ← the parent's HD slot for a child contract (ConstituentIncluded target);
 *   │                                            the child's own lifecycle stays at contracts/{childId}
 *   ├── tokens/{tokenId}                       ← receipt tokens (warehouse receipts, production rights, titles)
 *   └── event-log
 *   UAW  users/{u}/marketplace                 ← a person's private drafts, saved searches, sealed notes
 *   Agent party  {agentAccountRoot}/marketplace ← an agent's (NHC's) marketplace identity
 */
import { appTemplateRoot, operationalRoot, userInstanceRoot } from '../wallets/paths';

export const MARKETPLACE_APP_SLUG = 'marketplace';
export const MARKETPLACE_PTW_ROOT = appTemplateRoot(MARKETPLACE_APP_SLUG);
export const MARKETPLACE_POW_ROOT = operationalRoot(MARKETPLACE_APP_SLUG);
export const MARKETPLACE_EVENT_LOG = `${MARKETPLACE_POW_ROOT}/event-log`;
export const MARKETPLACE_AGENT_TEMPLATE = `${MARKETPLACE_PTW_ROOT}/agent`;
export const MARKETPLACE_AGENT_ADDRESS = `${MARKETPLACE_POW_ROOT}/agent`;
export const MARKETPLACE_GOVERNING_PRINCIPLE = "m/44'/144'/100'/principles/cope/v1#marketplace";

export const MARKETPLACE_PROCESSES = [
  { id: 'MarketplaceCommands', file: 'src/bpmn/marketplace/marketplace-commands.bpmn', label: 'Marketplace commands (verb bindings)' },
  { id: 'MarketplaceSupplyRequest', file: 'src/bpmn/marketplace/marketplace-supply-request.bpmn', label: 'Request → bids → award → production milestones' },
  { id: 'MarketplaceOrder', file: 'src/bpmn/marketplace/marketplace-order.bpmn', label: 'Buy a listing → escrow → delivery → release' },
  { id: 'MarketplaceTokenization', file: 'src/bpmn/marketplace/marketplace-tokenization.bpmn', label: 'Tokenize → transfer → redeem' },
  { id: 'MarketplaceAgentMandate', file: 'src/bpmn/marketplace/marketplace-agent-mandate.bpmn', label: 'Agent (NHC) mandate → act within limits → revoke' },
  { id: 'MarketplaceDiscovery', file: 'src/bpmn/marketplace/marketplace-discovery.bpmn', label: 'Market discovery → start a business' },
  { id: 'MarketplaceKnowledge', file: 'src/bpmn/marketplace/marketplace-knowledge.bpmn', label: 'Sell a knowledge graph under seal → verify → diagnose' },
  { id: 'MarketplaceSecurities', file: 'src/bpmn/marketplace/marketplace-securities.bpmn', label: 'Exempt security offering → compliance → verified investors' },
] as const;

export const marketplaceUawRoot = (userIndex: number | string) => userInstanceRoot(userIndex, MARKETPLACE_APP_SLUG);
export const partyAddress = (partyId: string) => `${MARKETPLACE_POW_ROOT}/parties/${partyId}`;
export const listingAddress = (listingId: string) => `${MARKETPLACE_POW_ROOT}/listings/${listingId}`;
export const requestAddress = (requestId: string) => `${MARKETPLACE_POW_ROOT}/requests/${requestId}`;
export const offerAddress = (requestId: string, offerId: string) => `${requestAddress(requestId)}/offers/${offerId}`;
export const contractRoot = (contractId: string) => `${MARKETPLACE_POW_ROOT}/contracts/${contractId}`;
export const contractAgreement = (contractId: string) => `${contractRoot(contractId)}/agreement`;
export const contractEscrow = (contractId: string) => `${contractRoot(contractId)}/escrow`;
export const contractMilestone = (contractId: string, n: number) => `${contractRoot(contractId)}/milestones/${n}`;
export const contractDelivery = (contractId: string, n: number) => `${contractRoot(contractId)}/deliveries/${n}`;
export const contractDispute = (contractId: string, n: number) => `${contractRoot(contractId)}/disputes/${n}`;
export const contractReview = (contractId: string, partyId: string) => `${contractRoot(contractId)}/reviews/${partyId}`;
/** The HD child position of a parent contract that a subcontract occupies; the parent's ConstituentIncluded TX targets it. */
export const subcontractAddress = (parentId: string, childId: string) => `${contractRoot(parentId)}/subcontracts/${childId}`;
export const tokenAddress = (tokenId: string) => `${MARKETPLACE_POW_ROOT}/tokens/${tokenId}`;
/** A marketplace operator (site administrator or delegated app administrator) acting by their pseudonymous party id. */
export const operatorAddress = (partyId: string) => `${MARKETPLACE_POW_ROOT}/operators/${partyId}`;
/** Whether a TX was written from an operator address (the mirror's insert policy role-checks these; publicLog.ts). */
export const isOperatorAddress = (address: string) => address.startsWith(`${MARKETPLACE_POW_ROOT}/operators/`);
export const mandateAddress = (partyId: string, mandateId: string) => `${partyAddress(partyId)}/mandates/${mandateId}`;
/** SKU address used in the commodity leg memo (MarketplaceMemoValidator). */
export const skuAddress = (listingOrRequestId: string) => `${MARKETPLACE_POW_ROOT}/sku/${listingOrRequestId}`;
/** v15-31-00: a signed reputation attestation for a party, by UTC date (reputationAttestation.ts). */
export const reputationAddress = (partyId: string, date: string) => `${partyAddress(partyId)}/reputation/${date}`;
/** v15-32-00: an evaluator's signed verdict on one deliverable of one milestone (HD child of the milestone; the deliverable's hash names it). */
export const verdictAddress = (contractId: string, milestone: number, deliverableSha256: string) => `${contractMilestone(contractId, milestone)}/verdicts/${deliverableSha256.slice(0, 16)}`;
/** v15-38-00: payment instructions a party declared (HD child of the party); anchors and the revocation are its children. */
export const payeeInstructionsAddress = (partyId: string, instructionsId: string) => `${partyAddress(partyId)}/payee-instructions/${instructionsId}`;
