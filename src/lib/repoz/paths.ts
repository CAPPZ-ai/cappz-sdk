/** Canonical wallet paths for the federated RepoZ skill (AP-17). */
import { WALLET_ROOTS, accountGroupPath, operationalRoot, userInstanceRoot } from '../wallets/paths';

/** Generic RepoZ skill (any platform can instantiate it). */
export const REPOZ_GENERIC_SKILL_ROOT = `${WALLET_ROOTS.REPOZ}/skills/repoz`;
/** cappz-repoz = the RepoZ instance for the CAPPZ platform. */
export const REPOZ_SLUG = 'cappz-repoz';
export const REPOZ_PTW_ROOT = `${WALLET_ROOTS.REPOZ}/templates/${REPOZ_SLUG}`;
export const REPOZ_POW_ROOT = operationalRoot(REPOZ_SLUG);
export const REPOZ_SKILL_ROOT = `${REPOZ_PTW_ROOT}/skills/repoz`;
export const REPOZ_EVENT_ROOT = `${REPOZ_POW_ROOT}/events`;
export const REPOZ_GOVERNING_PRINCIPLE = `${WALLET_ROOTS.REPOZ}/principles/cope/v1`;

export function repozBranchRoot(appRoot: string): string {
  return `${appRoot}/repoz`;
}

export function repozContentRoot(appRoot: string): string {
  return `${repozBranchRoot(appRoot)}/content`;
}

export function repozPrivateRoot(walletRoot: string): string {
  return `${repozBranchRoot(walletRoot)}/_local`;
}

export function repozAdministratorsGroup(appRoot: string): string {
  return accountGroupPath(appRoot, 'administrators');
}

export function repozUawRoot(userIndex: string | number): string {
  return userInstanceRoot(userIndex, REPOZ_SLUG);
}

export function repozAmendCommand(appSlug: string): string {
  return `${operationalRoot(appSlug)}/commands/repoz.amend`;
}

export function repozArtifactAddress(appRoot: string, artifactId: string): string {
  return `${repozContentRoot(appRoot)}/${encodeURIComponent(artifactId)}`;
}

export function repozBuildRoot(appRoot: string, buildVersion: string): string {
  return `${repozBranchRoot(appRoot)}/builds/${encodeURIComponent(buildVersion)}`;
}
/** Versioned renders (videos, animations) belong to cappz-repoz under the app branch media path. */
export function repozMediaAddress(appRoot: string, artifactId: string): string {
  return `${repozBranchRoot(appRoot)}/media/${encodeURIComponent(artifactId)}`;
}

/** Private, admin-read code branch. */
export function repozCodeRoot(appRoot: string): string {
  return `${repozBranchRoot(appRoot)}/code`;
}

/** External package dependencies (name@version + integrity). */
export function repozDependencyAddress(appRoot: string, pkg: string, version: string): string {
  return `${repozBranchRoot(appRoot)}/dependencies/${encodeURIComponent(`${pkg}@${version}`)}`;
}

export function repozPublicGroup(appRoot: string): string {
  return `${appRoot}/security/groups/public`;
}
