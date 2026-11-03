/**
 * COPE node crystallized. Node ID: v15-25-00-darc-split-rules.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * DARC split-rule validation, shared by every fee router (royalty routing,
 * marketplace fees, securities) and by the DARC contract itself.
 */
import type { DARCSplitRule } from './types';

/** The DARC split rules every contract must satisfy; returns violations (empty = valid). Shared by any fee router. */
export function validateDARCSplitRules(rules: DARCSplitRule[]): string[] {
  const violations: string[] = [];

  if (rules.length === 0) {
    violations.push('At least one split rule is required');
  }

  // Percentage rules must sum to ≤ 1.0 (tolerance: 0.5 + 0.3 + 0.2 is 1.0000000000000002 in floating point)
  const percentSum = rules
    .filter(r => r.splitType === 'percentage')
    .reduce((sum, r) => sum + r.value, 0);

  if (percentSum > 1.0 + 1e-9) {
    violations.push(`Percentage splits sum to ${(percentSum * 100).toFixed(2)}% — exceeds 100%`);
  }

  // Each rule value must be positive
  for (const rule of rules) {
    if (rule.value <= 0) {
      violations.push(`Split value must be positive: ${rule.targetAddress} has ${rule.value}`);
    }
    if (rule.splitType === 'percentage' && rule.value > 1) {
      violations.push(`Percentage split cannot exceed 100%: ${rule.targetAddress} has ${(rule.value * 100).toFixed(2)}%`);
    }
    if (!rule.targetAddress) {
      violations.push('Split rule must have a target address');
    }
  }

  // No duplicate target addresses
  const targets = rules.map(r => r.targetAddress);
  const uniqueTargets = new Set(targets);
  if (uniqueTargets.size !== targets.length) {
    violations.push('Duplicate target addresses in split rules');
  }

  return violations;
}
