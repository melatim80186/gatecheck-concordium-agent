// GateCheck Concordium — local test suite.
// Spawns server.mjs on a test port, runs the full matrix, exits 0/1.
//   npm test        (or: node test-local.mjs)
// Live checks (Concordium registry, BSC RPC) need network; the rest is local.
// The x402 facilitator /verify probe at the end is INFORMATIONAL only
// (a throwaway payer holds no test USDC, so verify may legitimately fail
// on balance) — it logs the facilitator's real answer and never fails the run.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256Hex, generateWallet, signTransferAuthorization, recoverAddress } from './lib/eth.js';
import { eip712TransferAuthorizationHash } from './lib/eth.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18098;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-secret-not-a-real-key';
const SEEN_FILE = path.join(DIR, 'seen.json');

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function verifySig(res, rawText) {
  const header = res.headers.get('x-agent-games-signature');
  if (!header || !/^[0-9a-f]{64}$/.test(header)) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(Buffer.from(rawText, 'utf8')).digest('hex');
  return header === expected;
}
async function get(p) {
  const res = await fetch(`${BASE}${p}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { res, text, json, sigOk: await verifySig(res, text) };
}
async function post(p, payload, { rawBody = null, headers = {} } = {}) {
  const body = rawBody ?? JSON.stringify(payload);
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { res, text, json, sigOk: await verifySig(res, text) };
}
async function postTask(payload, opts = {}) {
  const body = opts.rawBody ?? JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  if (opts.signed !== false) {
    headers['x-agent-games-signature'] =
      crypto.createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex');
  }
  const res = await fetch(`${BASE}/task`, { method: 'POST', headers, body });
  const text = await res.text();
  return { res, text, json: JSON.parse(text), sigOk: await verifySig(res, text) };
}

const VK = '0x7d3a00000000000000000000000000000000000000000000000000000000f291';
const RECIP = '0xDe4200000000000000000000000000000000009f01';
function baseTask(overrides = {}) {
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: 'gk_test',
    mode: 'practice',
    input: {
      registered_vk: VK, proof_vk: VK, minimum: '1000', public_balance: '1460',
      expiry_block: 19842201, current_block: 19832000,
      recipient: RECIP, condition_recipient: RECIP,
      amount: '500', max_transfer: '1000', proof_tx: '0xabc0000000000000000000000000000000000000000000000000000000000001',
      ...(overrides.input || {}),
    },
    ...(overrides.task || {}),
  };
}

// --- crypto unit checks (no server needed) ---
console.log('== eth.js ==');
check('keccak256("") vector', keccak256Hex('') === '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
check('keccak256("abc") vector', keccak256Hex('abc') === '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
{
  const w = generateWallet();
  check('wallet address format', /^0x[0-9a-f]{40}$/.test(w.address));
  const priv = Buffer.from(w.privateKey.slice(2), 'hex');
  const auth = {
    from: w.address, to: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    value: '5000', validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 3600),
    nonce: '0x' + crypto.randomBytes(32).toString('hex'),
  };
  const signed = signTransferAuthorization(priv, auth, { chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' });
  const digest = Buffer.from(eip712TransferAuthorizationHash({ chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', ...auth }).toString('hex'), 'hex');
  const sigBytes = Buffer.from(signed.signature.slice(2), 'hex');
  const recovered = recoverAddress(digest, {
    r: '0x' + sigBytes.subarray(0, 32).toString('hex'),
    s: '0x' + sigBytes.subarray(32, 64).toString('hex'),
    v: sigBytes[64],
  });
  check('EIP-712 sign -> ecrecover round-trip', recovered.toLowerCase() === w.address.toLowerCase(), `got ${recovered} want ${w.address}`);
}

// --- spawn server ---
console.log('== server ==');
const server = spawn('node', ['server.mjs'], {
  cwd: DIR,
  env: {
    ...process.env, PORT: String(PORT), AGENT_HMAC_SECRET: SECRET,
    AGENT_PUBLIC_URL: BASE, CONCORDIUM_NETWORK: 'testnet',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });
const kill = () => { try { server.kill('SIGTERM'); } catch { /* already dead */ } };
process.on('exit', kill);

let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try { const r = await fetch(`${BASE}/health`); if (r.ok) { up = true; break; } } catch { /* not up yet */ }
}
check('server boots', up);
if (!up) { console.log(serverOut); process.exit(1); }

try {
  // Health + signing
  const h = await get('/health');
  check('GET /health protocol-v1', h.json?.ok === true && h.json?.protocolVersion === 'v1');
  check('response HMAC signature verifies', h.sigOk);

  // Agent card + registration file + hash consistency
  const card = await get('/.well-known/agent-card.json');
  check('agent card serves', card.json?.name === 'GateCheck' && Array.isArray(card.json?.skills) && card.json.skills.length === 3);
  check('agent card has concordium extension', typeof card.json?.concordium?.extension === 'string' && card.json.concordium.extension.includes('concordium-badge'));
  const reg = await get('/.well-known/agent-registration.json');
  check('ERC-8004 registration file serves', reg.json?.type === 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
  check('registration lists A2A + MCP + x402 services',
    ['A2A', 'MCP', 'x402'].every((n) => reg.json?.services?.some((s) => s.name === n)));
  check('registration is honest: empty until registered', Array.isArray(reg.json?.registrations) && reg.json.registrations.length === 0);
  const cardHash = crypto.createHash('sha256').update(card.text, 'utf8').digest('hex');
  check('registration embeds the live card SHA-256', reg.json?.concordium?.agentCardSha256 === cardHash, `reg=${reg.json?.concordium?.agentCardSha256} live=${cardHash}`);
  const info = await get('/info');
  check('info reports concordium pending-registration', info.json?.concordium?.status === 'pending-registration');
  check('info reports x402 payTo', /^0x[0-9a-fA-F]{40}$/.test(info.json?.x402?.payTo || ''));
  const iconRes = await fetch(`${BASE}/agent.png`);
  const iconBuf = Buffer.from(await iconRes.arrayBuffer());
  check('agent icon is a real 128x128 PNG',
    iconRes.headers.get('content-type') === 'image/png' &&
    iconBuf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    iconBuf.readUInt32BE(16) === 128 && iconBuf.readUInt32BE(20) === 128);

  // Gate trap matrix (no badge)
  const t0 = await postTask(baseTask());
  check('valid task -> APPROVE VALID_CONDITION', t0.json?.decision === 'APPROVE' && t0.json?.reason_code === 'VALID_CONDITION', t0.text);
  check('approve response is signed', t0.sigOk);
  check('no-badge task reports badge.checked=false', t0.json?.badge?.checked === false);
  const tReuse = await postTask(baseTask());
  check('re-post same proof_tx -> REJECT PROOF_REUSED', tReuse.json?.decision === 'REJECT' && tReuse.json?.reason_code === 'PROOF_REUSED');
  const tVk = await postTask(baseTask({ input: { proof_vk: '0xdead', proof_tx: '0xabc0000000000000000000000000000000000000000000000000000000000002' } }));
  check('wrong VK -> REJECT VK_SUBSTITUTION', tVk.json?.reason_code === 'VK_SUBSTITUTION');
  const tTh = await postTask(baseTask({ input: { public_balance: '10', proof_tx: '0xabc0000000000000000000000000000000000000000000000000000000000003' } }));
  check('low balance -> REJECT THRESHOLD_MISMATCH', tTh.json?.reason_code === 'THRESHOLD_MISMATCH');
  const tEx = await postTask(baseTask({ input: { current_block: 19842202, proof_tx: '0xabc0000000000000000000000000000000000000000000000000000000000004' } }));
  check('expired -> REJECT EXPIRED_CONDITION', tEx.json?.reason_code === 'EXPIRED_CONDITION');
  const tRc = await postTask(baseTask({ input: { recipient: '0x1111111111111111111111111111111111111111', proof_tx: '0xabc0000000000000000000000000000000000000000000000000000000000005' } }));
  check('wrong recipient -> REJECT RECIPIENT_MISMATCH', tRc.json?.reason_code === 'RECIPIENT_MISMATCH');
  const tAm = await postTask(baseTask({ input: { amount: '9999', proof_tx: '0xabc0000000000000000000000000000000000000000000000000000000000006' } }));
  check('amount overflow -> REJECT AMOUNT_OVERFLOW', tAm.json?.reason_code === 'AMOUNT_OVERFLOW');
  const tBad = await postTask(null, { rawBody: '{not json' });
  check('malformed JSON -> REJECT (fail closed)', tBad.json?.decision === 'REJECT');
  const tPre = await postTask({ type: 'agent-games.preflight.v1' });
  check('preflight handshake', tPre.json?.ok === true && tPre.json?.protocolVersion === 'v1');

  // Gate + Concordium counterparty check (LIVE registry)
  const KNOWN_BADGE = 'Mf22soLh1NuZYFgBK8iSs'; // real mainnet agent, badge_valid=true (verified 2026-11-18)
  const tVerified = await postTask(baseTask({
    input: {
      proof_tx: '0xabc0000000000000000000000000000000000000000000000000000000000007',
      counterparty_badge: KNOWN_BADGE, counterparty_network: 'mainnet',
    },
  }));
  check('verified counterparty badge -> decision proceeds (APPROVE)',
    tVerified.json?.decision === 'APPROVE' && tVerified.json?.badge?.verified === true, tVerified.text);
  const tBogus = await postTask(baseTask({
    input: {
      proof_tx: '0xabc0000000000000000000000000000000000000000000000000000000000008',
      counterparty_badge: 'BogusBadge111111', counterparty_network: 'mainnet',
    },
  }));
  check('bogus counterparty badge -> REJECT AGENT_UNVERIFIED',
    tBogus.json?.decision === 'REJECT' && tBogus.json?.reason_code === 'AGENT_UNVERIFIED', tBogus.text);

  // Live Concordium check endpoints
  const ca = await get(`/check-agent?id=${KNOWN_BADGE}&network=mainnet`);
  check('GET /check-agent mainnet known badge verified', ca.json?.verified === true && ca.json?.found === true && ca.json?.active === true && ca.json?.cardHashMatches === true, ca.text.slice(0, 200));
  const caBad = await get('/check-agent?id=NotABadge!!&network=mainnet');
  check('GET /check-agent invalid id -> verified=false', caBad.json?.verified === false);
  const caTest = await get('/check-agent?id=TestnetBadge11111&network=testnet');
  check('GET /check-agent testnet unknown badge -> found=false, no crash',
    caTest.json?.found === false && caTest.json?.verified === false, caTest.text.slice(0, 300));

  // ProofCheck live (BSC): Paw Gang #840 owner (from ProofCheck README)
  const v = await post('/verify', {
    type: 'nft-owner',
    contract: '0x587C303982187Ec578dF309d27670327b13202F8',
    tokenId: 840,
    owner: '0xD99A6a19Bb7A59e0bd22134CDA94768EF999c3c1',
  });
  check('POST /verify nft-owner live (Paw Gang #840)', v.json?.verdict === 'verified', v.text.slice(0, 200));
  const vBad = await post('/verify', { type: 'nft-owner', contract: '0x1234', tokenId: 1, owner: '0xD99A6a19Bb7A59e0bd22134CDA94768EF999c3c1' });
  check('POST /verify malformed -> invalid', vBad.json?.verdict === 'invalid');

  // MCP
  const mInit = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  check('MCP initialize', mInit.json?.result?.serverInfo?.name === 'gatecheck-concordium');
  const mList = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  check('MCP tools/list has 4 tools', Array.isArray(mList.json?.result?.tools) && mList.json.result.tools.length === 4);
  const mCall = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_agent', arguments: { id: KNOWN_BADGE, network: 'mainnet' } } });
  const mCallObj = JSON.parse(mCall.json?.result?.content?.[0]?.text || '{}');
  check('MCP tools/call check_agent live', mCallObj.verified === true, mCall.text.slice(0, 200));
  const mGate = await post('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gate_decision', arguments: { task: baseTask({ input: { proof_tx: '0xabc0000000000000000000000000000000000000000000000000000000000009' } }) } } });
  const mGateObj = JSON.parse(mGate.json?.result?.content?.[0]?.text || '{}');
  check('MCP tools/call gate_decision', mGateObj.decision === 'APPROVE');
  const mBad = await post('/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  check('MCP unknown tool -> JSON-RPC error', mBad.json?.error?.code === -32603);

  // A2A
  const a2a = await post('/a2a', {
    jsonrpc: '2.0', id: 1, method: 'message/send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: JSON.stringify({ skill: 'check_agent', id: KNOWN_BADGE, network: 'mainnet' }) }] } },
  });
  const a2aObj = JSON.parse(a2a.json?.result?.artifacts?.[0]?.parts?.[0]?.text || '{}');
  check('A2A message/send check_agent live', a2aObj.verified === true, a2a.text.slice(0, 200));
  const a2aTaskId = a2a.json?.result?.id;
  const a2aGet = await post('/a2a', { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: a2aTaskId } });
  check('A2A tasks/get round-trips', a2aGet.json?.result?.id === a2aTaskId);
  const a2aBad = await post('/a2a', { jsonrpc: '2.0', id: 3, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'text', text: 'not json' }] } } });
  check('A2A non-JSON message -> failed task, not a crash', a2aBad.json?.result?.status?.state === 'failed');

  // x402: 402 challenge
  const x1 = await post('/verify-paid', { type: 'supply', contract: '0x265B2A6b32045af53d142f4e32123B28B0df4d7c' });
  check('POST /verify-paid without payment -> HTTP 402', x1.res.status === 402, `status=${x1.res.status}`);
  const challenge = JSON.parse(Buffer.from(x1.res.headers.get('PAYMENT-REQUIRED') || '', 'base64').toString('utf8'));
  check('402 PAYMENT-REQUIRED challenge decodes (x402 v2, exact, Base Sepolia USDC)',
    challenge?.x402Version === 2 && challenge?.accepts?.[0]?.scheme === 'exact' &&
    challenge?.accepts?.[0]?.network === 'eip155:84532' &&
    /^0x[0-9a-fA-F]{40}$/.test(challenge?.accepts?.[0]?.payTo || ''), JSON.stringify(challenge).slice(0, 300));
  const x2 = await post('/verify-paid', { type: 'supply', contract: '0x265B2A6b32045af53d142f4e32123B28B0df4d7c' }, {
    headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: 'eip155:84532', payload: { garbage: true } }), 'utf8').toString('base64') },
  });
  check('POST /verify-paid with garbage payment -> 402, not a crash', x2.res.status === 402, `status=${x2.res.status} ${x2.text.slice(0, 150)}`);

  // x402 full path: properly signed EIP-3009 payload from a throwaway payer
  // with no test USDC -> local checks pass, facilitator rejects on funds.
  // This proves the verify path runs end to end; settlement itself needs a
  // funded payer (see README / X402 status).
  {
    const w = generateWallet();
    const priv = Buffer.from(w.privateKey.slice(2), 'hex');
    const auth = {
      from: w.address, to: info.json?.x402?.payTo,
      value: '5000', validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 3600),
      nonce: '0x' + crypto.randomBytes(32).toString('hex'),
    };
    const { signTransferAuthorization: signAuth } = await import('./lib/eth.js');
    const signed = signAuth(priv, auth, { chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' });
    const requirements = {
      scheme: 'exact', network: 'eip155:84532', amount: '5000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: info.json?.x402?.payTo, maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    };
    const payload = {
      x402Version: 2, scheme: 'exact', network: 'eip155:84532',
      payload: { signature: signed.signature, authorization: auth },
      accepted: requirements,
    };
    const x3 = await post('/verify-paid', { type: 'supply', contract: '0x265B2A6b32045af53d142f4e32123B28B0df4d7c' }, {
      headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') },
    });
    check('POST /verify-paid signed-but-unfunded -> 402 with facilitator verdict (not a crash)',
      x3.res.status === 402 && typeof x3.json?.error === 'string', `status=${x3.res.status} ${x3.text.slice(0, 200)}`);
    console.log(`  INFO signed-unfunded facilitator verdict: ${(x3.json?.error || '').slice(0, 300)}`);
    check('facilitator rejects ONLY on balance (signature + EIP-712 domain accepted)',
      (x3.json?.error || '').includes('insufficient_balance'), (x3.json?.error || '').slice(0, 200));
  }

  // Audit trail
  const au = await get('/audit?limit=5');
  check('audit chain verifies', au.json?.chain?.ok === true, JSON.stringify(au.json?.chain));
  check('audit has entries', Array.isArray(au.json?.entries) && au.json.entries.length > 0);

  // --- INFORMATIONAL: live x402 facilitator /verify with a real signed payload ---
  console.log('== x402 facilitator probe (informational) ==');
  try {
    const w = generateWallet();
    const priv = Buffer.from(w.privateKey.slice(2), 'hex');
    const auth = {
      from: w.address, to: info.json?.x402?.payTo,
      value: '5000', validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 3600),
      nonce: '0x' + crypto.randomBytes(32).toString('hex'),
    };
    const signed = signTransferAuthorization(priv, auth, { chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' });
    // x402 v2 facilitator shape: { x402Version, paymentPayload, paymentRequirements }
    const requirements = {
      scheme: 'exact', network: 'eip155:84532', amount: '5000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: info.json?.x402?.payTo, maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    };
    const payload = {
      x402Version: 2, scheme: 'exact', network: 'eip155:84532',
      payload: { signature: signed.signature, authorization: auth },
      accepted: requirements,
    };
    const fr = await fetch('https://facilitator.payai.network/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
      signal: AbortSignal.timeout(30000),
    });
    const ftext = await fr.text();
    console.log(`  INFO facilitator /verify HTTP ${fr.status}: ${ftext.slice(0, 400)}`);
    console.log(`  INFO payer ${w.address} holds no test USDC — expect isValid:false / insufficient_funds; a schema error here would mean OUR payload shape is wrong.`);
  } catch (e) {
    console.log(`  INFO facilitator probe error: ${e.message}`);
  }
} finally {
  kill();
  try { fs.writeFileSync(SEEN_FILE, '[]\n'); } catch { /* ignore */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
