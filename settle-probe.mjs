// settle-probe.mjs — live x402 settle demo for GateCheck (Concordium).
//
// What it does:
//   1. Reads the persistent throwaway payer from x402-payer.json (mode 600,
//      gitignored — NEVER print the key; only the address is ever shown).
//   2. Checks the payer's Base Sepolia USDC balance on the public RPC.
//      If 0, it STOPS here with the faucet instructions — no spend, no error.
//   3. If funded (>= $0.005), starts the server locally, signs an EIP-3009
//      transfer authorization for $0.005 USDC, POSTs /verify-paid, and prints
//      the facilitator settle result: txHash + verdict.
//
// Cost when funded: $0.005 test USDC (worthless testnet token) from the
// throwaway payer to the agent's own payTo wallet. The payer needs NO test
// ETH: under the x402 `exact` scheme the facilitator submits the transfer
// and pays the gas.
//
// Run:  node settle-probe.mjs
// Fund first (user step): https://faucet.circle.com -> USDC, Base Sepolia,
//   address 0xe6e139d5292efd5ffb63347b33b6fc13dd7feab8 (20 test USDC / 2h).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { generateWallet, signTransferAuthorization } from './lib/eth.js';

const RPC = 'https://base-sepolia-rpc.publicnode.com';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PRICE = '5000'; // $0.005, 6 decimals
const PAYER_FILE = new URL('./x402-payer.json', import.meta.url);
const PORT = 18082;

const payer = JSON.parse(fs.readFileSync(PAYER_FILE, 'utf8'));
console.log(`payer: ${payer.address}`);
console.log(`(private key loaded from x402-payer.json — never printed)`);

// 1. Balance check (read-only).
const data = '0x70a08231' + '000000000000000000000000' + payer.address.slice(2);
const balRes = await fetch(RPC, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC, data }, 'latest'] }),
  signal: AbortSignal.timeout(20000),
});
const bal = BigInt((await balRes.json()).result || '0x0');
console.log(`payer Base Sepolia USDC: ${(Number(bal) / 1e6).toFixed(6)} USDC`);
if (bal < BigInt(PRICE)) {
  console.log('NOT FUNDED — nothing to settle. Fund the payer first:');
  console.log('  https://faucet.circle.com -> USDC -> Base Sepolia ->');
  console.log(`  ${payer.address}  (20 test USDC per request, 1x / 2h, no account)`);
  console.log('Then re-run: node settle-probe.mjs');
  process.exit(0);
}

// 2. Start the server locally.
const server = spawn('node', ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT), AGENT_HMAC_SECRET: 'settle-probe-local' },
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${PORT}`;
try {
  for (let i = 0; i < 20; i++) {
    try { const h = await fetch(`${base}/health`); if (h.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const info = await (await fetch(`${base}/info`)).json();
  console.log(`server up; x402 payTo: ${info.x402.payTo}`);

  // 3. Sign EIP-3009 authorization and pay.
  const auth = {
    from: payer.address, to: info.x402.payTo, value: PRICE,
    validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 3600),
    nonce: '0x' + crypto.randomBytes(32).toString('hex'),
  };
  const signed = signTransferAuthorization(
    Buffer.from(payer.privateKey.slice(2), 'hex'), auth,
    { chainId: 84532, verifyingContract: USDC },
  );
  const requirements = {
    scheme: 'exact', network: 'eip155:84532', amount: PRICE, asset: USDC,
    payTo: info.x402.payTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
  };
  const payload = {
    x402Version: 2, scheme: 'exact', network: 'eip155:84532',
    payload: { signature: signed.signature, authorization: auth }, accepted: requirements,
  };
  const res = await fetch(`${base}/verify-paid`, {
    method: 'POST', headers: {
      'content-type': 'application/json',
      'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    },
    body: JSON.stringify({ type: 'supply', contract: '0x265B2A6b32045af53d142f4e32123B28B0df4d7c' }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`HTTP ${res.status}`);
  if (body.payment?.settled) {
    console.log('SETTLED ✅');
    console.log(`  txHash: ${body.payment.txHash}`);
    console.log(`  verify: https://sepolia.basescan.org/tx/${body.payment.txHash}`);
    console.log(`  verdict: ${JSON.stringify(body.verdict ?? body.decision ?? null)}`);
    console.log(`  payer: ${body.payment.payer}  amount: $${Number(body.payment.amount) / 1e6} USDC`);
  } else {
    console.log('NOT SETTLED ❌');
    console.log(JSON.stringify(body).slice(0, 500));
  }
} finally {
  server.kill();
}
