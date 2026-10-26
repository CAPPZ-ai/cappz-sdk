import { describe, it, expect } from 'vitest';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { issueSelfSignedCertificate, parseCertificate, verifySelfSignature, certificateBindings, KEYDECL_URI_PREFIX } from '../lib/identity/x509';
import { didKeyFor, parseDidKey, base58btc, fromBase58btc } from '../lib/identity/didKey';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';

const days = (n: number) => new Date(Date.now() + n * 86400_000);

describe('v15-09-00 X.509 projection of wallet-declared keys', () => {
  it('P-256: Node parses the certificate, checks its signature and reads the SAN', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const wallet = keyPairFromPhrase(generateRecoveryPhrase());
    const did = didKeyFor('secp256k1', wallet.address);
    const cert = await issueSelfSignedCertificate({
      keyPair, algorithm: 'p256', commonName: wallet.address.slice(0, 32), organization: 'CAPPZ node',
      dnsNames: ['localhost', 'relay.example.com'], ipAddresses: ['127.0.0.1', '::1'], uris: [did, `${KEYDECL_URI_PREFIX}${'ab'.repeat(32)}`], notAfter: days(13),
    });
    const x = new X509Certificate(cert.pem);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.subjectAltName).toContain('DNS:relay.example.com');
    expect(x.subjectAltName).toContain(`URI:${did}`);
    expect(x.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(x.subjectAltName).toMatch(/IP Address:0?:?0?:?.*:1/i);
    expect(x.fingerprint256.replace(/:/g, '').toLowerCase()).toBe(cert.sha256);
    expect(createPrivateKey(cert.keyPem!).asymmetricKeyType).toBe('ec');
    const parsed = await parseCertificate(cert.pem);
    expect(parsed.algorithm).toBe('p256');
    expect(parsed.publicKeyHex).toBe(Buffer.from(await crypto.subtle.exportKey('raw', keyPair.publicKey)).toString('hex'));
    expect(parsed.dnsNames).toEqual(['localhost', 'relay.example.com']);
    expect(await verifySelfSignature(parsed)).toBe(true);
    expect(certificateBindings(parsed)).toEqual({ walletDid: did, declarationHashes: ['ab'.repeat(32)] });
    expect(parsed.notAfter.getTime() - Date.now()).toBeLessThanOrEqual(13 * 86400_000);
  });

  it('Ed25519: Node verifies it; a tampered certificate fails our own check', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const cert = await issueSelfSignedCertificate({ keyPair, algorithm: 'ed25519', commonName: 'edge-node', notAfter: days(30) });
    const x = new X509Certificate(cert.pem);
    expect(x.verify(x.publicKey)).toBe(true);
    const parsed = await parseCertificate(cert.der);
    expect(await verifySelfSignature(parsed)).toBe(true);
    const bad = cert.der.slice(); bad[bad.length - 70] ^= 1;
    expect(await verifySelfSignature(await parseCertificate(bad))).toBe(false);
  });

  it('did:key round-trips wallet (secp256k1), TLS (P-256) and device (Ed25519) keys', async () => {
    const wallet = keyPairFromPhrase(generateRecoveryPhrase());
    const did = didKeyFor('secp256k1', wallet.address);
    expect(did.startsWith('did:key:zQ3s')).toBe(true); // secp256k1 did:key prefix
    expect(parseDidKey(did)).toEqual({ algorithm: 'secp256k1', publicKeyHex: wallet.address });
    expect(didKeyFor('p256', '04' + '11'.repeat(64)).startsWith('did:key:zDn')).toBe(true);
    expect(didKeyFor('ed25519', '22'.repeat(32)).startsWith('did:key:z6Mk')).toBe(true);
    expect(parseDidKey('did:key:znotbase58!')).toBeNull();
    const b = Uint8Array.of(0, 0, 1, 2, 255);
    expect(fromBase58btc(base58btc(b))).toEqual(b);
  });
});
