/** v15-10-00 — FTPS server face (into quarantine) and the read-only LDAP directory face. */
import { describe, it, expect } from 'vitest';
import { createFtpSession, safeFtpName, type FtpIo } from '../lib/sync/transports/ftpServer';
import { createLegacyGateway, memoryQuarantineStore } from '../lib/sync/transports/legacyGateway';
import { answerLdap, ldapClient, splitMessages, escapeDnValue } from '../lib/sync/ldapDirectory';
import type { DirectoryRow } from '../lib/sync/directoryView';

const node = "m/44'/144'/0'/cappz/operational/dmz-node";
const xml = new TextEncoder().encode('<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"/>');

function io(upload?: Uint8Array): FtpIo & { listed: string; sent: string[] } {
  const o = { listed: '', sent: [] as string[], preliminary: async (l: string) => { o.sent.push(l); }, remote: '203.0.113.7:51000', openPassive: async () => ({ host: '127.0.0.1', port: 50123 }), readData: async (max: number) => { if (upload!.length > max) throw new Error('file too large'); return upload!; }, writeData: async (b: Uint8Array) => { o.listed = new TextDecoder().decode(b); } };
  return o;
}

describe('FTPS server face', () => {
  const setup = () => {
    const store = memoryQuarantineStore();
    const gw = createLegacyGateway({ nodeAddress: node, store });
    const ftp = createFtpSession({ accounts: [{ user: 'bank-a', passEnv: 'BANK_A_FTP_PASS', sender: 'bank-a batch' }], env: { BANK_A_FTP_PASS: 's3cret' }, maxBytes: 1024 * 1024, store: gw.intakeFile, released: async () => (await gw.entries()).filter((e) => e.state === 'released').map((e) => ({ name: e.name, size: e.size, sha256: e.sha256 })) });
    return { ftp, store };
  };

  it('a batch job logs in, uploads into quarantine, gets the receipt in the reply, and lists released files', async () => {
    const { ftp, store } = setup();
    expect(ftp.greeting).toMatch(/^220 /);
    expect((await ftp.handle('STOR x.xml', io())).replies).toEqual(['530 Log in first']);
    await ftp.handle('USER bank-a', io());
    expect((await ftp.handle('PASS s3cret', io())).replies[0]).toMatch(/^230 /);
    expect((await ftp.handle('PROT C', io())).replies[0]).toMatch(/^536 /);
    expect((await ftp.handle('STOR pain001.xml', io(xml))).replies).toEqual(['425 Use EPSV or PASV first']);
    expect((await ftp.handle('EPSV', io())).replies[0]).toBe('229 Entering Extended Passive Mode (|||50123|)');
    const up = io(xml);
    const stor = await ftp.handle('STOR pain001.xml', up);
    expect(up.sent).toEqual(['150 Receiving']); // sent before the data is read: clients wait for it
    expect(stor.replies[0]).toMatch(/^226 Received: released sha256=[0-9a-f]{64}/);
    expect(store.txs.find((t) => t.eventType === 'ContentQuarantined')!.payload.source).toEqual(expect.objectContaining({ kind: 'ftps-push', sender: 'bank-a batch' }));
    await ftp.handle('PASV', io());
    const l = io(); await ftp.handle('NLST', l);
    expect(l.listed).toBe('pain001.xml\r\n');
    expect((await ftp.handle('RETR pain001.xml', io())).replies[0]).toMatch(/^550 .*write-only/);
    expect((await ftp.handle('QUIT', io())).close).toBe(true);
  });

  it('rejects bad names, oversize uploads and executables; three failed logins close the session', async () => {
    const { ftp } = setup();
    expect(safeFtpName('../etc/passwd')).toBeNull();
    expect(safeFtpName('/ok.csv')).toBe('ok.csv');
    await ftp.handle('USER bank-a', io());
    expect((await ftp.handle('PASS wrong', io())).replies[0]).toBe('530 Login incorrect');
    await ftp.handle('USER nobody', io());
    expect((await ftp.handle('PASS s3cret', io())).replies[0]).toBe('530 Login incorrect');
    const third = await ftp.handle('PASS again', io());
    expect(third.close).toBe(true);
    const { ftp: f2 } = setup();
    await f2.handle('USER bank-a', io()); await f2.handle('PASS s3cret', io());
    await f2.handle('EPSV', io());
    expect((await f2.handle('STOR big.bin', io(new Uint8Array(2 * 1024 * 1024)))).replies[0]).toMatch(/^552 /);
    await f2.handle('EPSV', io());
    expect((await f2.handle('STOR run.exe', io(Uint8Array.from([0x4d, 0x5a, 0, 0])))).replies[0]).toMatch(/^250 Received, rejected: .*executable/);
    await f2.handle('EPSV', io());
    expect((await f2.handle('STOR ../x', io(xml))).replies[0]).toBe('553 File name not allowed');
  });
});

describe('LDAP directory face', () => {
  const rows: DirectoryRow[] = [
    { walletAddress: 'w1', copyId: 'c1', deviceId: 'node-a', address: 'w1/replicator/network/members/c1/devices/node-a', name: 'Treasury node', parent: "m/44'/144'/0'/ontology/domains", ordinal: 1, endpoints: [{ scope: 'lan', url: 'tcp://10.0.0.5:41441', carriers: ['tcp'] }], trust: 'declared-device', registeredAt: '2026-10-26T00:00:00Z' },
    { walletAddress: 'w2', copyId: 'c2', deviceId: 'node-b', address: 'w2/replicator/network/members/c2/devices/node-b', name: null, parent: 'unplaced', ordinal: 0, endpoints: [], trust: 'undeclared-device', registeredAt: '2026-10-26T00:00:00Z' },
  ];
  const opts = { base: 'dc=cappz', rows: async () => rows };
  const ask = async (m: Uint8Array) => answerLdap(m, opts);

  it('anonymous bind only; root DSE names the base', async () => {
    expect(ldapClient.decode((await ask(ldapClient.bind(1))).responses).code).toBe(0);
    expect(ldapClient.decode((await ask(ldapClient.bind(2, 'cn=admin'))).responses).code).toBe(48);
    const dse = ldapClient.decode((await ask(ldapClient.search(3, '', 0, ldapClient.present('objectClass')))).responses);
    expect(dse.entries[0].attrs.namingContexts).toEqual(['dc=cappz']);
  });

  it('subtree search with equality and present filters; unplaced devices are listed, never guessed', async () => {
    const all = ldapClient.decode((await ask(ldapClient.search(4, 'dc=cappz', 2, ldapClient.eq('objectClass', 'cappzDevice')))).responses);
    expect(all.code).toBe(0);
    expect(all.entries.map((e) => e.dn)).toEqual([`cn=node-a,ou=${escapeDnValue("m/44'/144'/0'/ontology/domains")},dc=cappz`, 'cn=node-b,ou=unplaced,dc=cappz']);
    const named = ldapClient.decode((await ask(ldapClient.search(5, 'dc=cappz', 2, ldapClient.and(ldapClient.present('displayName'), ldapClient.eq('cappzCarrier', 'tcp')), ['cn', 'cappzEndpoint']))).responses);
    expect(named.entries).toEqual([{ dn: expect.stringContaining('cn=node-a'), attrs: { cn: ['node-a'], cappzEndpoint: ['tcp://10.0.0.5:41441'] } }]);
    const one = ldapClient.decode((await ask(ldapClient.search(6, 'dc=cappz', 1, ldapClient.present('objectClass')))).responses);
    expect(one.entries.every((e) => e.dn.startsWith('ou='))).toBe(true);
    expect(ldapClient.decode((await ask(ldapClient.search(7, 'dc=nowhere', 2, ldapClient.present('cn')))).responses).code).toBe(32);
  });

  it('frames split cleanly from a stream and unbind closes', async () => {
    const both = new Uint8Array([...ldapClient.bind(1), ...ldapClient.search(2, '', 0, ldapClient.present('objectClass')).subarray(0, 5)]);
    const { messages, rest } = splitMessages(both);
    expect(messages).toHaveLength(1);
    expect(rest.length).toBe(5);
    expect((await ask(Uint8Array.from([0x30, 0x05, 0x02, 0x01, 0x09, 0x42, 0x00]))).close).toBe(true);
  });
});
