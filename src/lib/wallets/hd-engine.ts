/**
 * HD Wallet Engine — Core Types & Utilities
 * 
 * Deterministic address derivation for the Metatron cosmological MDM model.
 * All wallets are HD wallets — every address is deterministically derived from seed + path.
 * Iterators maintain sibling order within branches.
 */

// ─── Core Types ───

export interface HDNodeVersion {
  version: string;
  effectiveDate: string;
  changeType: 'initial' | 'additive' | 'subtractive' | 'corrective';
  summary: string;
}

export interface HDNodeValue {
  code: string;
  label: string;
  status: 'active' | 'deprecated' | 'pending';
}

/** Template definition for message generation */
export interface HDNodeTemplate {
  name: string;
  description?: string;
  format: 'xml' | 'json' | 'csv' | 'edi';
  content: string;
}

/** Schema definition for validation */
export interface HDNodeSchema {
  name: string;
  format: 'xsd' | 'json-schema' | 'relaxng';
  content: string;
}

export interface HDNode {
  /** Child index in HD derivation path (hardened) */
  index: number;
  /** Human-readable label */
  label: string;
  /** Optional description/source reference */
  description?: string;
  /** Child nodes */
  children?: HDNode[];
  /** Arbitrary metadata (e.g., source references, status) */
  metadata?: Record<string, unknown>;
  /** Representative sample values for this coding scheme */
  sampleValues?: HDNodeValue[];
  /** Version history for this coding scheme */
  versions?: HDNodeVersion[];
  /** Exemplar templates for message generation (Phase 13) */
  templates?: HDNodeTemplate[];
  /** Validation schemas (XSD, JSON Schema) for generated messages (Phase 13) */
  schemas?: HDNodeSchema[];
  /** References to composable parent schemes (scheme-of-schemes) */
  schemeOfSchemes?: string[];
}

/** A BPMN process step in a standard workflow */
export interface BPMNProcessStep {
  id: string;
  label: string;
  description: string;
  /** Whether this step is an extension point for enterprise customization */
  isExtensionPoint?: boolean;
  /** Step type for visual rendering */
  stepType?: 'start' | 'task' | 'gateway' | 'subprocess' | 'end' | 'extension';
}

/** A BPMN workflow process catalog entry */
export interface BPMNProcess {
  processId: string;
  name: string;
  description: string;
  /** Standard catalog version this process belongs to */
  catalogVersion: string;
  steps: BPMNProcessStep[];
}

/** Factory Agent configuration sourced from the wallet */
export interface FactoryAgentConfig {
  /** Factory Agent name, e.g. "ISDA FpML Message Factory Agent" */
  agentName: string;
  /** What Deal/Trade/Message agents this factory produces */
  producesAgents: string;
  /** Value proposition sections */
  valueProp: {
    headline: string;
    points: string[];
  };
  /** Key message types this factory generates */
  messageTypes: {
    code: string;
    name: string;
    description: string;
  }[];
  /** BPMN process catalog */
  processes: BPMNProcess[];
  /** Analytics capabilities enabled by ConstituentIncluded TXs */
  analyticsCapabilities: string[];
}

export interface HDWallet {
  /** Canonical wallet name (e.g., 'cappz-heaven-wallet') */
  name: string;
  /** Root HD derivation path */
  rootPath: string;
  /** Short description */
  description: string;
  /** Visibility tier: 'substrate' (hidden) or 'standard' (developer-facing) */
  visibility: 'substrate' | 'standard';
  /** Domain category */
  domain: string;
  /**
   * v14-16-19 explicit ontology placement (never inferred from name or address).
   * Path under the HEWN creation root, e.g. 'creation', 'standards/financial', 'domains'.
   */
  ontologyParent?: string;
  /** HD tree definition */
  tree: HDNode[];
  /** Factory Agent configuration — embedded in wallet for self-contained rendering */
  factoryAgent?: FactoryAgentConfig;
  /**
   * Embedded AI agent that administers this wallet and acts as the user-interaction
   * surface (chat, vetting, queries). AX-95: every wallet MUST declare one.
   */
  embeddedAgent?: EmbeddedWalletAgent;
}

/** AX-95: embedded-agent descriptor attached to every wallet. */
export interface EmbeddedWalletAgent {
  /** Skill ID registered with SkillRegistry (e.g. 'cappz:principles'). */
  skillId: string;
  /** MDM HD address of the skill (resolves via SkillRegistry). */
  mdmAddress: string;
  /** Role this agent plays for the wallet. */
  role: 'admin' | 'user' | 'admin+user';
  /** Short human label, e.g. 'Principles Agent'. */
  label?: string;
}


export interface FlatNode {
  /** Full HD derivation path */
  path: string;
  /** Human-readable label */
  label: string;
  /** Tree depth (0 = root) */
  depth: number;
  /** Description */
  description?: string;
}

// ─── Derivation Utilities ───

/**
 * Derive a child path from a root path.
 * All indices are hardened (appended with ').
 */
export function derivePath(root: string, ...indices: number[]): string {
  return root + indices.map(i => `/${i}'`).join('');
}

/**
 * Flatten an HDWallet tree into a list of FlatNodes for display/serialization.
 */
export function flattenTree(wallet: HDWallet): FlatNode[] {
  const result: FlatNode[] = [];

  function walk(nodes: HDNode[], parentPath: string, depth: number) {
    for (const node of nodes) {
      const path = `${parentPath}/${node.index}'`;
      result.push({
        path,
        label: node.label,
        depth,
        description: node.description,
      });
      if (node.children?.length) {
        walk(node.children, path, depth + 1);
      }
    }
  }

  walk(wallet.tree, wallet.rootPath, 0);
  return result;
}

/**
 * Count total nodes in a wallet tree.
 */
export function countNodes(wallet: HDWallet): number {
  let count = 0;
  function walk(nodes: HDNode[]) {
    for (const node of nodes) {
      count++;
      if (node.children?.length) walk(node.children);
    }
  }
  walk(wallet.tree);
  return count;
}

/**
 * Find a node by label (case-insensitive, first match).
 */
export function findNode(wallet: HDWallet, label: string): { node: HDNode; path: string } | null {
  const lower = label.toLowerCase();
  function walk(nodes: HDNode[], parentPath: string): { node: HDNode; path: string } | null {
    for (const node of nodes) {
      const path = `${parentPath}/${node.index}'`;
      if (node.label.toLowerCase().includes(lower)) {
        return { node, path };
      }
      if (node.children?.length) {
        const found = walk(node.children, path);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(wallet.tree, wallet.rootPath);
}

/**
 * Serialize a wallet tree to a human-readable text block (for AI system prompts).
 */
export function serializeTreeToText(wallet: HDWallet): string {
  const lines: string[] = [
    `${wallet.name} — ${wallet.description}`,
    `Root: ${wallet.rootPath}`,
    `Visibility: ${wallet.visibility}`,
    `Domain: ${wallet.domain}`,
    '',
  ];

  const flat = flattenTree(wallet);
  for (const node of flat) {
    const indent = '  '.repeat(node.depth);
    const desc = node.description ? ` — ${node.description}` : '';
    lines.push(`${indent}${node.path}: ${node.label}${desc}`);
  }

  return lines.join('\n');
}
