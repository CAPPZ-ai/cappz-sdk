/**
 * COPE node crystallized. Node ID: v14-16-11-runtime-image
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Runtime image = the executable equivalent of a build: minified, bundled JS
 * (closest analog PCode/bytecode, not native binary). Deterministic from
 * source + build config, so it is its own artifact kind with its own
 * fingerprint, linked to the source snapshot it was built from.
 *
 * Also: the interop guard — the shared core is the ONLY coupling point
 * between apps; direct app-to-app references are refused at bind time.
 */
import { repozBranchRoot } from './paths';
import { PLATFORM_SLUG } from './artifactVersioning';

export type RuntimeImageKind = 'runtime-image';

export interface RuntimeImageArtifact {
  kind: RuntimeImageKind;
  appSlug: string;
  buildVersion: string;
  /** Fingerprint of the built bundle (gzipped bytes stored separately). */
  imageHash: string;
  /** Fingerprint of the source snapshot the image was built from. */
  sourceSnapshotHash: string;
}

/** Address of a build's runtime image under the app branch. */
export function runtimeImageAddress(appRoot: string, buildVersion: string): string {
  return `${repozBranchRoot(appRoot)}/runtime/${encodeURIComponent(buildVersion)}`;
}

/** Provenance payload: executable → exact source snapshot. */
export function runtimeImagePayload(img: RuntimeImageArtifact) {
  return {
    kind: img.kind,
    buildVersion: img.buildVersion,
    imageHash: img.imageHash,
    sourceSnapshotHash: img.sourceSnapshotHash,
    governingPrinciple: "m/44'/144'/100'/principles/cope/v1#wallet-content",
  };
}

/**
 * Interop guard: an app may reference its own branch or the shared core
 * (platform) branch. Direct references into another app's branch bypass the
 * core and break independent release — refused at bind time.
 */
export function assertCoreOnlyReference(fromAppSlug: string, targetAddress: string): { ok: true } | { ok: false; reason: string } {
  if (fromAppSlug === PLATFORM_SLUG) return { ok: true }; // platform may bind anywhere
  const own = repozBranchRoot(fromAppSlug);
  const core = repozBranchRoot(PLATFORM_SLUG);
  if (targetAddress.startsWith(own) || targetAddress.startsWith(core)) return { ok: true };
  return { ok: false, reason: 'cross-app-reference-outside-core' };
}

/**
 * Stage B flag: resolve a module from the wallet runtime image when enabled,
 * with tradCode (server bundle) fallback. Stage C (authority flip) removes
 * the fallback per app once the prebuild version scan is green.
 */
export type RuntimeSource = 'wallet' | 'tradcode';
export function resolveRuntimeSource(opts: { stageBEnabled: boolean; stageCFlipped?: boolean; walletHasImage: boolean }): RuntimeSource {
  if (opts.stageCFlipped) return 'wallet'; // no fallback after the flip
  if (opts.stageBEnabled && opts.walletHasImage) return 'wallet';
  return 'tradcode';
}
