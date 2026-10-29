import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateRecoveryPhrase, keyPairFromPhrase, signMessage } from '../lib/auth/wallet/session';
import { canonicalJson } from '../lib/identity/canonical';
import { createCharter } from '../lib/mesh/meshIdentity';
import { verifyKit, zipKitDir, type KitManifest } from '../../packages/cappz-mesh-node/kit';

const sha = (b: string) => crypto.createHash('sha256').update(b).digest('hex');

async function fakeKit(signer?: { address: string; privateKey: Uint8Array }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'));
  const files = { 'cappz-mesh.mjs': 'console.log(1)\n', 'start.sh': '#!/bin/sh\n', 'web/app.js': '1' };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  let m: KitManifest = { v: 1, kind: 'cpz-mesh-kit', builtAt: new Date().toISOString(), sdkVersion: 'test', files: Object.fromEntries(Object.entries(files).map(([f, c]) => [f, sha(c)])) };
  if (signer) { m = { ...m, signer: signer.address }; const { signature: _s, ...rest } = m; m.signature = await signMessage(signer.privateKey, canonicalJson(rest)); }
  fs.writeFileSync(path.join(dir, 'KIT-MANIFEST.json'), JSON.stringify(m));
  return dir;
}

describe('v15-13-00 mesh go-kit', () => {
  it('verifies a kit signed by a charter authority and reports every other state', async () => {
    const auth = keyPairFromPhrase(generateRecoveryPhrase());
    const charter = await createCharter(auth.privateKey, { name: 'k', authorities: [auth.address] });
    const dir = await fakeKit({ address: auth.address, privateKey: auth.privateKey });
    expect((await verifyKit(dir, charter)).state).toBe('verified-by-authority');
    const stranger = keyPairFromPhrase(generateRecoveryPhrase());
    expect((await verifyKit(await fakeKit({ address: stranger.address, privateKey: stranger.privateKey }), charter)).state).toBe('signed-unknown-signer');
    expect((await verifyKit(await fakeKit())).state).toBe('unsigned');
    fs.appendFileSync(path.join(dir, 'cappz-mesh.mjs'), '// evil');
    expect(await verifyKit(dir, charter)).toMatchObject({ state: 'tampered', files: ['cappz-mesh.mjs'] });
    const extra = await fakeKit({ address: auth.address, privateKey: auth.privateKey });
    fs.writeFileSync(path.join(extra, 'payload.sh'), 'rm -rf ~');
    expect(await verifyKit(extra, charter)).toMatchObject({ state: 'tampered', files: ['+payload.sh'] });
    const forged = await fakeKit({ address: auth.address, privateKey: auth.privateKey });
    const m = JSON.parse(fs.readFileSync(path.join(forged, 'KIT-MANIFEST.json'), 'utf8')) as KitManifest;
    fs.writeFileSync(path.join(forged, 'KIT-MANIFEST.json'), JSON.stringify({ ...m, sdkVersion: 'other' }));
    expect((await verifyKit(forged, charter)).state).toBe('bad-signature');
    expect(zipKitDir(dir).byteLength).toBeGreaterThan(100);
  });
});
