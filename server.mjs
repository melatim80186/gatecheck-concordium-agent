// GateCheck — Concordium Trusted Agents Hackathon (Encode Club)
// An agent you already run, made accountable.
//
// What this is: GateCheck (zkVerify Agent Games Proof Gatekeeper) +
// ProofCheck (on-chain claim verification) + the Concordium additions
// the hackathon brief asks for:
//   1. Verified-by-Concordium badge — counterparty agents are checked
//      against the live Concordium Agent Registry (CIS-8004) before any
//      decision is approved; unverified counterparties REJECT with
//      AGENT_UNVERIFIED. Reads Concordium's public badge-check REST
//      (mainnet) and hosted MCP (testnet/devnet). No keys, no wallet.
//   2. ERC-8004 Agent Card + Agent Registry — A2A card at
//      /.well-known/agent-card.json and the ERC-8004 registration file at
//      /.well-known/agent-registration.json, with a SHA-256 card hash that
//      becomes the CIS-8004 metadata_hash at registration (REGISTER.md).
//   3. x402 agent payments — POST /verify-paid answers HTTP 402 with a
//      PAYMENT-REQUIRED challenge (exact scheme, Base Sepolia USDC,
//      $0.005) and verifies + settles via a facilitator.
//   4. MCP + A2A — an MCP server at POST /mcp (check_agent, verify_claim,
//      gate_decision, audit_status) and a minimal A2A surface at POST /a2a.
//   5. Audit trail — every decision / verification / payment is logged
//      to a hash-chained JSONL trail (EU AI Act record-keeping).
//
// Node 22 stdlib only — zero dependencies. No private keys for the agent's
// own decisions; the only key material on disk is the agent's throwaway
// EVM wallet for x402 payTo (x402-wallet.json, mode 600, agent-owned).
//
// Env:
//   PORT                 (default 8080)
//   AGENT_HMAC_SECRET    HMAC secret for response signing (x-agent-games-signature)
//   AGENT_PUBLIC_URL     public base URL (default http://127.0.0.1:PORT)
//   CONCORDIUM_NETWORK   testnet (default) | mainnet | devnet
//   CONCORDIUM_TOKEN_ADDRESS / CONCORDIUM_TOKEN_ID — set AFTER registration
//   X402_PAY_TO          override the agent wallet as x402 payTo
//   BSC_RPC              override BSC RPC (single URL)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide } from './lib/gate.js';
import { verifyClaim } from './lib/proof.js';
import { checkAgent } from './lib/concordium.js';
import { buildIdentityDocs } from './lib/card.js';
import {
  paymentRequired, readPaymentPayload, payerOf,
  verifyAndSettle, paymentResponse, DEFAULTS as X402_DEFAULTS,
} from './lib/x402.js';
import { handleMcp } from './lib/mcp.js';
import { handleA2a } from './lib/a2a.js';
import { log as auditLog, verifyChain, recent as auditRecent } from './lib/audit.js';
import { loadOrCreateWallet } from './lib/wallet.js';
import { agentPng } from './lib/icon.js';

const PORT = Number(process.env.PORT || 8080);
const HMAC_SECRET = process.env.AGENT_HMAC_SECRET || '';
const PUBLIC_URL = (process.env.AGENT_PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const CONCORDIUM_NETWORK = process.env.CONCORDIUM_NETWORK || 'testnet';
const CONCORDIUM_TOKEN_ADDRESS = process.env.CONCORDIUM_TOKEN_ADDRESS || null;
const CONCORDIUM_TOKEN_ID = process.env.CONCORDIUM_TOKEN_ID ? Number(process.env.CONCORDIUM_TOKEN_ID) : null;
const MAX_BODY = 65536;
const DIR = path.dirname(fileURLToPath(import.meta.url));
const SEEN_FILE = path.join(DIR, 'seen.json');

// Agent identity documents (card + registration file + card hash).
const identity = buildIdentityDocs({
  publicUrl: PUBLIC_URL,
  network: CONCORDIUM_NETWORK,
  tokenAddress: CONCORDIUM_TOKEN_ADDRESS,
  tokenId: CONCORDIUM_TOKEN_ID,
});

// x402 payTo: env override, else the agent's own wallet (created at boot).
const agentWallet = loadOrCreateWallet();
const X402_PAY_TO = process.env.X402_PAY_TO || agentWallet.address;

// Seen-set (proof reuse memory), same as GateCheck.
const seen = new Set();
try {
  const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  if (Array.isArray(raw)) for (const tx of raw) if (typeof tx === 'string' && tx) seen.add(tx);
  console.log(`[gatecheck] loaded ${seen.size} seen proof_tx from seen.json`);
} catch { console.log('[gatecheck] no usable seen.json — starting with an empty seen-set'); }
function saveSeen() {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen], null, 2) + '\n'); }
  catch (e) { console.error(`[gatecheck] WARN could not persist seen.json: ${e.message}`); }
}

// Signing — HMAC-SHA256, bare lowercase hex, over the raw response body,
// in x-agent-games-signature (same scheme as GateCheck / ProofCheck).
function signHeaders(body) {
  if (!HMAC_SECRET) return {};
  const sig = crypto.createHmac('sha256', HMAC_SECRET)
    .update(Buffer.from(body, 'utf8')).digest('hex');
  return { 'x-agent-games-signature': sig };
}
function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    ...signHeaders(body),
    ...extraHeaders,
  });
  res.end(body);
}

const INCOMING_SIG_HEADERS = [
  'x-agent-games-signature', 'x-agent-signature', 'x-signature', 'signature',
];
function verifyIncoming(req, rawBody) {
  if (!HMAC_SECRET) return { checked: false, ok: false, detail: 'no secret configured' };
  const headerName = INCOMING_SIG_HEADERS.find((h) => req.headers[h] !== undefined);
  if (!headerName) return { checked: false, ok: false, detail: 'no signature header present' };
  const presented = String(req.headers[headerName]).replace(/^sha256=/i, '').trim();
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(rawBody).digest('hex');
  let ok = false;
  try {
    ok = presented.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch { ok = false; }
  return { checked: true, ok, detail: ok ? `verified via ${headerName}` : `MISMATCH via ${headerName}` };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Gate decision with the Concordium counterparty check (check 0).
// If the task names a counterparty badge (input.counterparty_badge or
// input.agent_badge), that agent MUST be Verified by Concordium or the
// decision is REJECT / AGENT_UNVERIFIED — before any of the 6 trap checks.
// If no badge is named, the decision proceeds and badge.checked=false.
// ---------------------------------------------------------------------------
async function handleTask(req, res) {
  let raw;
  try { raw = await readRawBody(req); }
  catch {
    return send(res, 200, { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION', proof_tx: null });
  }
  const incoming = verifyIncoming(req, raw);
  let task = null;
  try { task = JSON.parse(raw.toString('utf8')); }
  catch {
    return send(res, 200, { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION', proof_tx: null });
  }
  if (!task || typeof task !== 'object') {
    return send(res, 200, { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION', proof_tx: null });
  }
  if (typeof task.type === 'string' && task.type.startsWith('agent-games.preflight')) {
    return send(res, 200, { ok: true, protocolVersion: 'v1' });
  }

  const input = (task.input && typeof task.input === 'object') ? task.input : {};
  const badgeId = input.counterparty_badge || input.agent_badge || null;
  let badge = { checked: false };
  if (badgeId) {
    try {
      const network = input.counterparty_network || CONCORDIUM_NETWORK;
      badge = { checked: true, ...(await checkAgent(String(badgeId), { network })) };
    } catch (e) {
      badge = { checked: true, verified: false, error: `registry unreachable: ${e.message}` };
    }
    if (!badge.verified) {
      const out = {
        decision: 'REJECT',
        reason_code: 'AGENT_UNVERIFIED',
        proof_tx: typeof input.proof_tx === 'string' ? input.proof_tx : null,
        badge: { checked: true, verified: false, id: String(badgeId), issues: badge.issues || [badge.error || 'counterparty agent is not Verified by Concordium'] },
      };
      auditLog('gate_decision', { task_id: task.task_id || '?', decision: 'REJECT', reason: 'AGENT_UNVERIFIED', badge: String(badgeId) });
      console.log(`[${new Date().toISOString()}] task_id=${task.task_id || '?'} decision=REJECT reason=AGENT_UNVERIFIED badge=${badgeId}`);
      return send(res, 200, out);
    }
  }

  let out;
  try { out = decide({ ...task, _seen: seen }); }
  catch (e) {
    console.error(`[gatecheck] ERROR decide() threw: ${e.message}`);
    out = { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION', proof_tx: null };
  }
  if (out.decision === 'APPROVE' && out.proof_tx) { seen.add(out.proof_tx); saveSeen(); }
  out.badge = badge.checked ? { checked: true, verified: badge.verified, id: String(badgeId) } : { checked: false };
  auditLog('gate_decision', { task_id: task.task_id || '?', decision: out.decision, reason: out.reason_code, badge_checked: badge.checked });
  console.log(`[${new Date().toISOString()}] task_id=${task.task_id || '?'} decision=${out.decision} reason=${out.reason_code} badge_checked=${badge.checked} incoming_sig=${incoming.detail}`);
  return send(res, 200, out);
}

// ---------------------------------------------------------------------------
// Paid verification (x402): POST /verify-paid.
// No PAYMENT-SIGNATURE -> 402 + PAYMENT-REQUIRED. With a payload -> verify
// + settle via the facilitator -> PAYMENT-RESPONSE + the verdict.
// ---------------------------------------------------------------------------
async function handleVerifyPaid(req, res) {
  let raw;
  try { raw = await readRawBody(req); }
  catch { return send(res, 400, { verdict: 'invalid', reason: 'unreadable body' }); }
  let claim = null;
  try { claim = JSON.parse(raw.toString('utf8')); } catch {
    return send(res, 400, { verdict: 'invalid', reason: 'malformed JSON' });
  }
  const payment = readPaymentPayload(req);
  const requirements = paymentRequired({ payTo: X402_PAY_TO }).accepts[0];
  if (!payment) {
    auditLog('x402_challenge', { endpoint: '/verify-paid', payTo: X402_PAY_TO, amount: X402_DEFAULTS.amount, network: X402_DEFAULTS.network });
    const challenge = paymentRequired({ payTo: X402_PAY_TO });
    const body = JSON.stringify({ error: 'Payment Required', x402: challenge });
    res.writeHead(402, {
      'content-type': 'application/json',
      'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge), 'utf8').toString('base64'),
      ...signHeaders(body),
    });
    return res.end(body);
  }
  // Never charge for a malformed claim: the shape check is free and local,
  // so it runs BEFORE any settlement. (A malformed JSON body was already
  // rejected with 400 above, before a payment was even requested.)
  if (!claim || typeof claim !== 'object' ||
      !['nft-owner', 'tx', 'supply'].includes(claim.type)) {
    return send(res, 400, {
      verdict: 'invalid',
      reason: 'unknown or missing claim type (nft-owner | tx | supply) — no payment taken',
    });
  }
  const result = await verifyAndSettle(payment, requirements);
  if (!result.verified || !result.settled) {
    auditLog('x402_rejected', { payer: payerOf(payment), error: result.error });
    return send(res, 402, {
      verdict: 'invalid',
      reason: 'payment not verified/settled',
      error: result.error,
      x402: paymentRequired({ payTo: X402_PAY_TO }),
    }, {
      'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(paymentRequired({ payTo: X402_PAY_TO })), 'utf8').toString('base64'),
    });
  }
  // Payment settled — the claim was already shape-checked above, so the
  // paid verification always runs.
  let out;
  try { out = await verifyClaim(claim); }
  catch (e) { return send(res, 502, { verdict: 'error', reason: `RPC failure: ${e.message}` }); }
  out.payment = { settled: true, txHash: result.txHash, payer: payerOf(payment), network: X402_DEFAULTS.network, amount: X402_DEFAULTS.amount, asset: X402_DEFAULTS.asset };
  auditLog('x402_settled', { payer: out.payment.payer, txHash: result.txHash, verdict: out.verdict });
  return send(res, 200, out, { 'PAYMENT-RESPONSE': paymentResponse({ txHash: result.txHash }) });
}

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    const query = new URL(req.url, 'http://localhost').searchParams;

    if (req.method === 'GET' && (url === '/' || url === '/health' || url === '/agent')) {
      return send(res, 200, { ok: true, protocolVersion: 'v1' });
    }
    if (req.method === 'GET' && url === '/info') {
      return send(res, 200, {
        agent: 'GateCheck',
        edition: 'Concordium Trusted Agents Hackathon (Encode Club)',
        idea: identity.card.description,
        endpoints: [
          'GET /health', 'GET /.well-known/agent-card.json',
          'GET /.well-known/agent-registration.json',
          'GET /check-agent?id=<badge|account>&network=testnet',
          'POST / {task}', 'POST /task {task}',
          'POST /verify {claim}', 'POST /verify-paid {claim} (x402)',
          'POST /mcp (MCP Streamable HTTP)', 'POST /a2a (A2A JSON-RPC)',
          'GET /audit',
        ],
        signed: Boolean(HMAC_SECRET),
        signature_header: 'x-agent-games-signature',
        concordium: {
          network: CONCORDIUM_NETWORK,
          registry: 'https://agent-registry.concordium.com',
          status: CONCORDIUM_TOKEN_ADDRESS ? 'registered' : 'pending-registration',
          tokenAddress: CONCORDIUM_TOKEN_ADDRESS,
          agentCardSha256: identity.cardSha256,
        },
        x402: {
          network: X402_DEFAULTS.network,
          asset: X402_DEFAULTS.asset,
          amount: X402_DEFAULTS.amount,
          payTo: X402_PAY_TO,
          facilitator: X402_DEFAULTS.facilitator,
        },
        seen_proofs: seen.size,
      });
    }
    if (req.method === 'GET' && url === '/.well-known/agent-card.json') {
      // Serve the EXACT bytes whose SHA-256 is committed in the
      // registration file (and will be the CIS-8004 metadata_hash):
      // re-stringifying would change the bytes and break the hash.
      const body = identity.cardJson;
      res.writeHead(200, {
        'content-type': 'application/json',
        ...signHeaders(body),
      });
      return res.end(body);
    }
    if (req.method === 'GET' && (url === '/.well-known/agent-registration.json' || url === '/agent-registration.json')) {
      return send(res, 200, identity.registration);
    }
    if (req.method === 'GET' && url === '/agent-card.json') {
      const body = identity.cardJson;
      res.writeHead(200, {
        'content-type': 'application/json',
        ...signHeaders(body),
      });
      return res.end(body);
    }
    if (req.method === 'GET' && url === '/agent.png') {
      const png = agentPng();
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      return res.end(png);
    }
    if (req.method === 'GET' && url === '/check-agent') {
      const id = query.get('id');
      const network = query.get('network') || CONCORDIUM_NETWORK;
      if (!id) return send(res, 400, { error: 'need ?id=<badge|account>&network=testnet|mainnet|devnet' });
      try {
        const out = await checkAgent(id, { network });
        auditLog('check_agent', { id, network, verified: out.verified });
        return send(res, 200, out);
      } catch (e) {
        return send(res, 502, { error: `registry unreachable: ${e.message}` });
      }
    }
    if (req.method === 'GET' && url === '/concordium') {
      return send(res, 200, {
        network: CONCORDIUM_NETWORK,
        registry: 'https://agent-registry.concordium.com',
        status: CONCORDIUM_TOKEN_ADDRESS ? 'registered' : 'pending-registration',
        tokenAddress: CONCORDIUM_TOKEN_ADDRESS,
        tokenId: CONCORDIUM_TOKEN_ID,
        agentUri: `${PUBLIC_URL}/.well-known/agent-card.json`,
        agentCardSha256: identity.cardSha256,
        note: 'Registration (CIS-8004 mint) is owner-side via the Agent Registry app — see REGISTER.md.',
      });
    }
    if (req.method === 'GET' && url === '/audit') {
      const limit = Number(query.get('limit')) || 50;
      return send(res, 200, { chain: verifyChain(), entries: auditRecent(limit) });
    }
    if (req.method === 'POST' && (url === '/' || url === '/task' || url === '/agent')) {
      return handleTask(req, res);
    }
    if (req.method === 'POST' && url === '/verify') {
      let claim = null;
      try { claim = JSON.parse((await readRawBody(req)).toString('utf8')); }
      catch { return send(res, 400, { verdict: 'invalid', reason: 'malformed JSON' }); }
      let out;
      try { out = await verifyClaim(claim); }
      catch (e) { return send(res, 502, { verdict: 'error', reason: `RPC failure: ${e.message}` }); }
      auditLog('verify_claim', { type: claim?.type, verdict: out.verdict });
      return send(res, 200, out);
    }
    if (req.method === 'POST' && url === '/verify-paid') {
      return handleVerifyPaid(req, res);
    }
    if (req.method === 'POST' && url === '/mcp') {
      let body = null;
      try { body = JSON.parse((await readRawBody(req)).toString('utf8')); }
      catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const out = await handleMcp(body, { seen });
      if (out === null) { res.writeHead(202); return res.end(); } // notification
      auditLog('mcp', { method: body?.method });
      return send(res, 200, out);
    }
    if (req.method === 'POST' && url === '/a2a') {
      let body = null;
      try { body = JSON.parse((await readRawBody(req)).toString('utf8')); }
      catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const out = await handleA2a(body, { seen });
      auditLog('a2a', { method: body?.method });
      return send(res, 200, out);
    }
    return send(res, 404, { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION', proof_tx: null });
  } catch (e) {
    console.error(`[gatecheck] ERROR ${req.method} ${req.url}: ${e.message}`);
    return send(res, 200, { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION', proof_tx: null });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`GateCheck (Concordium) listening on ${PORT}`);
  console.log(`  public URL: ${PUBLIC_URL}`);
  console.log(`  concordium: network=${CONCORDIUM_NETWORK} status=${CONCORDIUM_TOKEN_ADDRESS ? 'registered' : 'pending-registration'}`);
  console.log(`  agent card sha256: ${identity.cardSha256}`);
  console.log(`  x402 payTo: ${X402_PAY_TO} (${X402_DEFAULTS.network}, ${X402_DEFAULTS.amount} ${X402_DEFAULTS.asset.slice(0, 10)}…)`);
  console.log(`  signed=${Boolean(HMAC_SECRET)} seen=${seen.size}`);
});
