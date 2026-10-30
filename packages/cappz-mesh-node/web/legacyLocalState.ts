/**
 * COPE node crystallized.
 * Node ID: v15-13-02-mesh-web-legacy-state
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The only Web Storage access in the mesh phone app. Before 15.13.2 the app
 * kept its identity (recovery phrase, device keys, charter, grant) in
 * localStorage; it now lives in cappz-store (OPFS). The old value is read
 * once, and removed only after the caller has flushed it to cappz-store.
 */

export const LEGACY_MESH_KEY = 'cappz-mesh-v1';

/** The pre-15.13.2 saved state, or null when none is left (or Web Storage is unavailable). */
export function readLegacyMeshState(): string | null {
  try { return localStorage.getItem(LEGACY_MESH_KEY); } catch { return null; }
}

/** Remove the legacy copy; call only after cappz-store holds it durably. */
export function dropLegacyMeshState(): void {
  try { localStorage.removeItem(LEGACY_MESH_KEY); } catch { /* nothing to drop */ }
}
