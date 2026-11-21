/**
 * Real XRPL testnet run of the edge node's vault agents (15.49.0): the actual agents/server.ts under Deno,
 * driven over HTTP with real testnet payments.
 *
 *   npx vite-node tools/vault-agents-testnet.ts [-- --out <file>]
 *
 * Starts server.ts on 127.0.0.1:41470 (testnet, a throwaway node key and guard secret, a temp data folder, a
 * faucet-funded payout address), then:
 *   1. vault-check on a fresh vault → not-set-up (paid 1 XRP from the vault)
 *   2. vault-guard: guard address; job opened and paid 10 XRP from the vault with its master key → authorized
 *   3. signer list (node's guard, one operator, two recovery keys) and master key off → vault-check says load-bearing
 *   4. co-sign a 5 XRP payment to the allowed desk → approved; operator adds its signature → tesSUCCESS
 *   5. co-sign a drain to an unknown address → refused (reasons)
 *   6. the attack: a second job with a loosened policy, its fee paid by the vault THROUGH the guard (the fee itself
 *      is in policy) → not authorised (policy-change-needs-recovery); co-sign under it → 403
 *   7. a payment from a stranger's wallet for a guard on this vault → not-from-vault (job 3)
 *   8. break-glass: the two recovery keys move 2 XRP without the guard → the node's reconciliation alerts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, Wallet, multisign } from 'xrpl';
import { XRPL_ENDPOINTS } from '../src/lib/xrpl/ledgerCheck';
import { guardSetupTransactions } from '../src/lib/treasury/vaultGuard';

const PORT = 41470;
const BASE = `http://127.0.0.1:${PORT}/agents`;
const log = (...a: unknown[]) => console.error('·', ...a);
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('hex');
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function http(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: J; text: string }> {
  const r = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json: J = {}; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, json, text };
}

async function main() {
  const steps: J[] = [];
  const step = (name: string, data: J) => { steps.push({ name, ...data }); log(name, JSON.stringify(data).slice(0, 400)); };
  const client = new Client(XRPL_ENDPOINTS.testnet);
  await client.connect();
  const fund = async (): Promise<Wallet> => {
    for (let i = 0; ; i++) {
      try { return (await client.fundWallet()).wallet; } catch (e) { if (i >= 6) throw e; log('faucet busy, retry in', 20 * (i + 1), 's'); await sleep(20_000 * (i + 1)); }
    }
  };
  const payTo = await fund();
  await sleep(5000);
  const vault = await fund();
  await sleep(5000);
  const stranger = await fund();
  const [op, rec1, rec2] = [Wallet.generate(), Wallet.generate(), Wallet.generate()];
  const desk = Wallet.generate().classicAddress;
  const attacker = Wallet.generate().classicAddress;

  // Node key (Ed25519, pkcs8) and guard secret, throwaway.
  const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', k.privateKey)).toString('base64');
  const pub = hex(await crypto.subtle.exportKey('raw', k.publicKey));
  const data = await mkdtemp(join(tmpdir(), 'cappz-vault-agents-'));
  const deno = process.env.DENO ?? join(homedir(), '.deno', 'bin', 'deno');
  const sdk = resolve(__dirname, '..');
  const server: ChildProcess = spawn(deno, ['run', '--config', join(sdk, 'deno.json'), '--allow-net', '--allow-read', '--allow-write', '--allow-env', join(sdk, 'packages/cappz-edge-node/agents/server.ts')], {
    env: { ...process.env, CAPPZ_NODE_KEY: pkcs8, CAPPZ_NODE_PUB: pub, CAPPZ_AGENT_PAYTO: payTo.classicAddress, CAPPZ_AGENT_NETWORK: 'testnet', CAPPZ_AGENT_PORT: String(PORT), CAPPZ_AGENT_PUBLIC_BASE: BASE, CAPPZ_AGENT_DATA: data, CAPPZ_KEYZ_DISCOVER: '0', CAPPZ_VAULT_GUARD_SECRET: hex(crypto.getRandomValues(new Uint8Array(32))), CAPPZ_VAULT_RECONCILE_SECONDS: '15', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog: string[] = [];
  server.stdout!.on('data', (d) => serverLog.push(String(d)));
  server.stderr!.on('data', (d) => serverLog.push(String(d)));
  try {
    for (let i = 0; i < 120; i++) { try { if ((await http('GET', '/vault-check/health')).status === 200) break; } catch { /* starting */ } await sleep(1000); }
    step('server up', { health: (await http('GET', '/vault-check/health')).json });

    const pay = async (from: Wallet, p: J) => {
      const r = await client.submitAndWait({ TransactionType: 'Payment', Account: from.classicAddress, Destination: p.destination, DestinationTag: p.destinationTag, Amount: String(Math.round(Number(p.amount) * 1e6)) } as never, { wallet: from, autofill: true });
      return r.result.hash;
    };

    // 1. vault-check before setup.
    {
      const o = await http('POST', '/vault-check/jobs', { input: { account: vault.classicAddress } });
      const jobId = o.json.job.jobId;
      let r = await http('GET', `/vault-check/jobs/${jobId}/stages/0/result`);
      for (let i = 0; r.status === 409 && i < 60; i++) { await sleep(2000); r = await http('GET', `/vault-check/jobs/${jobId}/stages/0/result`); }
      const h = await pay(vault, r.json.pay);
      await http('POST', `/vault-check/jobs/${jobId}/payments`, { txHash: h });
      r = await http('GET', `/vault-check/jobs/${jobId}/stages/0/result`);
      step('1. vault-check before setup', { status: r.status, state: r.json.report?.payload?.state, findings: r.json.report?.payload?.findings?.map((f: J) => f.code) });
    }

    // 2. guard address, job, payment from the vault (master key).
    const guard = (await http('GET', `/vault-guard/guard/${vault.classicAddress}`)).json.guard as string;
    const policy = { destinations: [{ address: desk, label: 'Desk' }, { address: payTo.classicAddress, label: 'Guard renewals' }], limits: [{ asset: 'XRP', perTx: '12000000', perWindow: '30000000' }] };
    const open = await http('POST', '/vault-guard/jobs', { input: { account: vault.classicAddress, policy, recovery: [rec1.classicAddress, rec2.classicAddress], label: 'testnet run' } });
    const jobId = open.json.job.jobId as string;
    const h2 = await pay(vault, open.json.pay);
    await http('POST', `/vault-guard/jobs/${jobId}/payments`, { txHash: h2 });
    let st = await http('GET', `/vault-guard/status/${jobId}`);
    for (let i = 0; !st.json.active && i < 30; i++) { await sleep(2000); st = await http('GET', `/vault-guard/status/${jobId}`); }
    step('2. guard job paid from the vault', { guard, jobId, active: st.json.active, authorized: st.json.authorized });

    // 3. setup, then vault-check with the guard.
    for (const tx of guardSetupTransactions(vault.classicAddress, guard, [op.classicAddress], { perSpend: 1, recovery: [rec1.classicAddress, rec2.classicAddress] })) {
      const r = await client.submitAndWait(tx as never, { wallet: vault, autofill: true });
      step(`3. setup ${tx.TransactionType}`, { result: (r.result.meta as J).TransactionResult, hash: r.result.hash });
    }

    const cosign = async (job: string, tx: J) => {
      const prepared = await client.autofill(tx as never, 2) as unknown as J;
      return { prepared, r: await http('POST', `/vault-guard/cosign/${job}`, { tx: prepared }) };
    };

    // 4. in-policy payment.
    {
      const { prepared, r } = await cosign(jobId, { TransactionType: 'Payment', Account: vault.classicAddress, Destination: desk, Amount: '5000000' });
      let result: string | null = null; let hash: string | null = null;
      if (r.json.approved) {
        const s = await client.submitAndWait(multisign([r.json.txBlob, op.sign({ ...prepared, SigningPubKey: '' } as never, true).tx_blob]));
        result = (s.result.meta as J).TransactionResult; hash = s.result.hash;
      }
      step('4. co-sign 5 XRP to the desk', { status: r.status, approved: r.json.approved, setup: r.json.setup, result, hash });
    }
    // 5. drain.
    {
      const { r } = await cosign(jobId, { TransactionType: 'Payment', Account: vault.classicAddress, Destination: attacker, Amount: '60000000' });
      step('5. co-sign a drain', { status: r.status, approved: r.json.approved, reasons: r.json.reasons?.map((x: J) => x.code) });
    }
    // 6. loosened policy paid through the guard.
    let looseJob = '';
    {
      const loose = { destinations: [{ address: attacker, label: 'mine now' }], limits: [{ asset: 'XRP', perTx: '90000000', perWindow: '90000000' }] };
      const o = await http('POST', '/vault-guard/jobs', { input: { account: vault.classicAddress, policy: loose } });
      looseJob = o.json.job.jobId;
      const p = o.json.pay;
      const { prepared, r } = await cosign(jobId, { TransactionType: 'Payment', Account: vault.classicAddress, Destination: p.destination, DestinationTag: p.destinationTag, Amount: String(Math.round(Number(p.amount) * 1e6)) });
      let feeHash: string | null = null;
      if (r.json.approved) feeHash = (await client.submitAndWait(multisign([r.json.txBlob, op.sign({ ...prepared, SigningPubKey: '' } as never, true).tx_blob]))).result.hash;
      await http('POST', `/vault-guard/jobs/${looseJob}/payments`, { txHash: feeHash });
      let ls = await http('GET', `/vault-guard/status/${looseJob}`);
      for (let i = 0; !ls.json.active && i < 30; i++) { await sleep(2000); ls = await http('GET', `/vault-guard/status/${looseJob}`); }
      const { r: tryLoose } = await cosign(looseJob, { TransactionType: 'Payment', Account: vault.classicAddress, Destination: attacker, Amount: '60000000' });
      step('6. loosened policy, fee paid through the guard', { feeApproved: r.json.approved, feeHash, active: ls.json.active, authorized: ls.json.authorized, cosignStatus: tryLoose.status, cosignError: tryLoose.json.code ?? tryLoose.json.error });
    }
    // 7. a stranger pays for a guard on this vault.
    {
      const o = await http('POST', '/vault-guard/jobs', { input: { account: vault.classicAddress, policy: { destinations: [{ address: attacker, label: 'x' }], limits: [{ asset: 'XRP', perTx: '90000000', perWindow: '90000000' }] } } });
      const j3 = o.json.job.jobId;
      const h = await pay(stranger, o.json.pay);
      await http('POST', `/vault-guard/jobs/${j3}/payments`, { txHash: h });
      let s3 = await http('GET', `/vault-guard/status/${j3}`);
      for (let i = 0; !s3.json.active && i < 30; i++) { await sleep(2000); s3 = await http('GET', `/vault-guard/status/${j3}`); }
      const { r } = await cosign(j3, { TransactionType: 'Payment', Account: vault.classicAddress, Destination: attacker, Amount: '60000000' });
      step('7. stranger-paid guard job', { active: s3.json.active, authorized: s3.json.authorized, cosignStatus: r.status, cosignError: r.json.code });
    }
    // vault-check with the guard, after setup.
    {
      const o = await http('POST', '/vault-check/jobs', { input: { account: vault.classicAddress, guard, recovery: [rec1.classicAddress, rec2.classicAddress] } });
      const id = o.json.job.jobId;
      let r = await http('GET', `/vault-check/jobs/${id}/stages/0/result`);
      for (let i = 0; r.status === 409 && i < 60; i++) { await sleep(2000); r = await http('GET', `/vault-check/jobs/${id}/stages/0/result`); }
      const h = await pay(stranger, r.json.pay);
      await http('POST', `/vault-check/jobs/${id}/payments`, { txHash: h });
      r = await http('GET', `/vault-check/jobs/${id}/stages/0/result`);
      step('3b. vault-check after setup', { status: r.status, state: r.json.report?.payload?.state, findings: r.json.report?.payload?.findings?.map((f: J) => f.code) });
    }
    // 8. break-glass, then wait for the node's alert.
    {
      const prepared = await client.autofill({ TransactionType: 'Payment', Account: vault.classicAddress, Destination: attacker, Amount: '2000000' } as never, 2);
      const s = await client.submitAndWait(multisign([rec1.sign(prepared as never, true).tx_blob, rec2.sign(prepared as never, true).tx_blob]));
      let alerts = 0;
      for (let i = 0; i < 40 && !alerts; i++) { await sleep(3000); alerts = (await http('GET', `/vault-guard/status/${jobId}`)).json.alerts ?? 0; }
      step('8. break-glass by recovery keys, node alert', { result: (s.result.meta as J).TransactionResult, hash: s.result.hash, alerts });
    }

    const by = (n: string) => steps.find((s) => s.name.startsWith(n))!;
    const ok = by('1.').state === 'not-set-up'
      && by('2.').active && by('2.').authorized?.ok === true
      && by('3b.').state === 'guard-load-bearing'
      && by('4.').approved === true && by('4.').result === 'tesSUCCESS'
      && by('5.').approved === false && by('5.').reasons.includes('destination-not-allowed')
      && by('6.').feeApproved === true && by('6.').authorized?.code === 'policy-change-needs-recovery' && by('6.').cosignStatus === 403
      && by('7.').authorized?.code === 'not-from-vault' && by('7.').cosignStatus === 403
      && by('8.').result === 'tesSUCCESS' && by('8.').alerts >= 1;
    const record = { network: 'testnet', at: new Date().toISOString(), accounts: { payTo: payTo.classicAddress, vault: vault.classicAddress, desk, attacker, stranger: stranger.classicAddress }, steps, verdict: ok ? 'PASS' : 'FAIL' };
    if (out) await writeFile(out, JSON.stringify(record, null, 2));
    console.log(JSON.stringify({ verdict: record.verdict, out }));
    if (!ok) { console.error(serverLog.join('').slice(-4000)); process.exitCode = 1; }
  } finally {
    server.kill();
    await client.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
