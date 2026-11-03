/**
 * COPE node crystallized. Node ID: v15-00-01-knowledge-access.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Selling a knowledge graph without a separate store. The seller publishes a
 * listing, a public manifest (title, counts, Merkle root over every node and
 * edge leaf) and the bundle encrypted under a fresh content key. The content
 * key is sealed to the seller's own box key; nobody else can read it. When a
 * buyer's contract is funded, the seller seals the content key to the
 * buyer's published box key (AccessKeyDelivered) and evidences the delivery
 * milestone by that box's hash. The buyer opens it locally, decrypts the
 * bundle and checks it against the manifest's Merkle root before accepting —
 * a seller who ships a different graph is caught by the ledger, not by trust.
 *
 * Box private keys never appear in clear: in the live market they are sealed
 * under the person's session-wallet key (sealPrivate) and only their own
 * session can open them.
 */
import { decryptContent, encryptContent, newContentKey, openWith, sealTo, type ContentCipher, type SealedBox } from '../../crypto/sealedBox';
import { marketLedger, type MarketTx } from '../ledger';
import { contractDelivery, listingAddress, partyAddress } from '../MarketplacePaths';
import { MarketRuleError } from '../rules';
import type { MarketState } from '../replay';
import type { ListingContent } from '../types';
import type { Actor } from '../model';
import { buildListing } from '../model';
import { BUNDLE_VERSION, canonicalize, ciphertextHdPath, isValid, manifestHdPath, serializeBundle, sha256Hex, validateBundle, type BundleManifest, type PhytoBundle } from './graph';

const fail = (msg: string): never => { throw new MarketRuleError(msg); };
const tx = (eventType: MarketTx['eventType'], sourceAddress: string, targetAddress: string, payload: Record<string, unknown>) => marketLedger.create({ eventType, sourceAddress, targetAddress, payload });

export interface GraphPublication { listingId: string; manifest: BundleManifest & { merkleRoot: string; nodeCount: number; edgeCount: number }; cipher: ContentCipher; ciphertextHash: string; sellerKeyBox: SealedBox; publishedAt: string }
export interface AccessDelivery { contractId: string; milestone: number; listingId: string; sealed: SealedBox; at: string }

/** Register a party's box key: the public half on the profile, the private half sealed in their own wallet. */
export async function buildRegisterBoxKey(state: MarketState, actor: Actor, publicKey: JsonWebKey, sealedPrivate: Record<string, unknown>): Promise<MarketTx[]> {
  const p = state.parties.get(actor.partyId) ?? fail('Set up your marketplace profile first.');
  return [
    await tx('ContentAmended', partyAddress(p.partyId), partyAddress(p.partyId), { contentClass: 'party', profile: { ...p, encryptionKey: publicKey } }),
    await tx('ContentCreated', partyAddress(p.partyId), `${partyAddress(p.partyId)}/keys/box`, { contentClass: 'party-box-key', partyId: p.partyId, publicKey, sealedPrivate }),
  ];
}

/**
 * Publish a knowledge graph for sale. Returns the TXs: the listing, the public manifest, the ciphertext with the
 * content key sealed to the seller. The bundle must validate; it is serialized canonically so the buyer can re-derive the root.
 */
export async function buildPublishGraph(state: MarketState, actor: Actor, listing: Omit<ListingContent, 'categoryId' | 'unit' | 'knowledge'>, bundle: PhytoBundle): Promise<MarketTx[]> {
  const seller = state.parties.get(actor.partyId) ?? fail('Set up your marketplace profile first.');
  if (!seller.encryptionKey) fail('Create your encryption key first (profile → encryption key); buyers receive the graph key sealed by it.');
  const issues = validateBundle(bundle);
  if (!isValid(issues)) fail(`The graph does not validate: ${issues.slice(0, 3).map((i) => i.message).join(' · ')}`);
  const ser = await serializeBundle(bundle, listing.listingId);
  const manifest = JSON.parse(ser.manifestLeaf.payload) as GraphPublication['manifest'];
  const contentKey = await newContentKey();
  const cipher = await encryptContent(contentKey, canonicalize(bundle));
  const ciphertextHash = await sha256Hex(canonicalize(cipher));
  const full: ListingContent = { ...listing, categoryId: 'digital', unit: 'license', attributes: { ...listing.attributes, format: `${BUNDLE_VERSION}, encrypted; key sealed to the buyer` }, knowledge: { graphId: manifest.graphId, graphVersion: manifest.graphVersion, merkleRoot: ser.merkleRoot, nodeCount: manifest.nodeCount, edgeCount: manifest.edgeCount } };
  return [
    ...(await buildListing(state, actor, full)),
    await tx('ContentCreated', partyAddress(actor.partyId), manifestHdPath(listing.listingId), { contentClass: 'graph-manifest', listingId: listing.listingId, manifest }),
    await tx('ContentCreated', partyAddress(actor.partyId), ciphertextHdPath(listing.listingId), { contentClass: 'graph-ciphertext', listingId: listing.listingId, cipher, ciphertextHash, sellerKeyBox: await sealTo(seller.encryptionKey!, { listingId: listing.listingId, contentKey }) }),
  ];
}

/** Recover the content key of the seller's own graph (opens the box sealed to the seller). */
export async function sellerContentKey(state: MarketState, listingId: string, sellerPrivateKey: JsonWebKey): Promise<string> {
  const g = state.graphs.get(listingId) ?? fail('That listing has no graph.');
  return (await openWith<{ contentKey: string }>(sellerPrivateKey, g.sellerKeyBox)).contentKey;
}

/** Seller delivers access: content key sealed to the buyer, and delivery evidence by the box's hash. */
export async function buildDeliverAccessKey(state: MarketState, actor: Actor, contractId: string, contentKey: string): Promise<MarketTx[]> {
  const c = state.contracts.find((x) => x.contractId === contractId) ?? fail('Unknown contract.');
  if (c.sellerId !== actor.partyId) fail('Only the seller delivers access.');
  const listingId = c.source.kind === 'listing' ? c.source.listingId : '';
  if (!state.graphs.has(listingId)) fail('This contract is not for a knowledge graph.');
  const milestone = c.milestones.findIndex((m) => m.delivery);
  if (milestone < 0) fail('The contract has no delivery milestone.');
  const st = c.milestoneStates[milestone].state;
  if (st === 'affirmed' || st === 'released') fail('The buyer already accepted delivery.');
  if (c.escrow.balance <= 0) fail('Wait for the buyer to fund escrow before delivering the key.');
  const buyer = state.parties.get(c.buyerId);
  if (!buyer?.encryptionKey) fail('The buyer has not created an encryption key yet; ask them to (profile → encryption key).');
  const sealed = await sealTo(buyer!.encryptionKey!, { listingId, contentKey });
  const hash = await sha256Hex(canonicalize(sealed));
  return [
    await tx('AccessKeyDelivered', partyAddress(actor.partyId), contractDelivery(contractId, milestone), { contractId, milestone, listingId, sealed }),
    await tx('MilestoneEvidenced', partyAddress(actor.partyId), contractDelivery(contractId, milestone), { contractId, milestone, kind: 'document', hash, note: 'Graph access key sealed to the buyer; verify the Merkle root before accepting.' }),
  ];
}

export interface OpenedGraph { bundle: PhytoBundle; manifest: GraphPublication['manifest']; verified: boolean; derivedRoot: string; problems: string[] }

/** Buyer side: open the latest delivered key, decrypt, validate and check the Merkle root against the public manifest. */
export async function openPurchasedGraph(state: MarketState, contractId: string, buyerPrivateKey: JsonWebKey): Promise<OpenedGraph> {
  const d = (state.accessDeliveries.get(contractId) ?? []).at(-1) ?? fail('No access key delivered yet.');
  return openGraphWithBox(state, d.listingId, d.sealed, buyerPrivateKey);
}

/** Open any graph whose content key is sealed to `privateKey` (the buyer's delivery, or the seller's own box). */
export async function openGraphWithBox(state: MarketState, listingId: string, box: SealedBox, privateKey: JsonWebKey): Promise<OpenedGraph> {
  const g = state.graphs.get(listingId) ?? fail('That listing has no graph.');
  const { contentKey } = await openWith<{ contentKey: string; listingId: string }>(privateKey, box);
  const problems: string[] = [];
  if (await sha256Hex(canonicalize(g.cipher)) !== g.ciphertextHash) problems.push('Ciphertext does not match its published hash.');
  const bundle = JSON.parse(await decryptContent(contentKey, g.cipher)) as PhytoBundle;
  const issues = validateBundle(bundle);
  if (issues.length) problems.push(`Graph has ${issues.length} validation errors.`);
  const ser = await serializeBundle(bundle, listingId);
  if (ser.merkleRoot !== g.manifest.merkleRoot) problems.push('Merkle root differs from the published manifest: this is not the graph that was listed.');
  return { bundle, manifest: g.manifest, verified: problems.length === 0, derivedRoot: ser.merkleRoot, problems };
}
