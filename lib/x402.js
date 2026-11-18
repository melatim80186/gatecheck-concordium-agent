// lib/x402.js — x402 v2 server side (spec: github.com/coinbase/x402).
// Flow: client requests a paid endpoint without payment -> HTTP 402 with a
// base64 PAYMENT-REQUIRED header (the payment terms) -> client signs an
// EIP-3009 transferWithAuthorization and retries with PAYMENT-SIGNATURE ->
// server verifies + settles via a facilitator -> PAYMENT-RESPONSE header
// with the receipt, then the paid result.
//
// Defaults (all overridable by env):
//   network   eip155:84532 (Base Sepolia) — the canonical x402 demo rail
//   asset     Circle USDC on Base Sepolia 0x036CbD53842c5426634e7929541eC2318f3dCF7e
//   amount    5000 (6 decimals = $0.005 per paid verification)
//   payTo     the agent's own EVM wallet (generated at first boot, see wallet.js)
//   facilitator https://facilitator.payai.network (public facilitator)
// Honest scope: the protocol is implemented end to end in code. A live
// settled payment needs a payer holding Base Sepolia USDC (test faucet,
// user-side) — until then the 402 challenge + payload validation paths
// are what the tests exercise. Nothing here pretends a payment settled.
export const X402_VERSION = 2;

export const DEFAULTS = {
  network: process.env.X402_NETWORK || 'eip155:84532',
  asset: process.env.X402_ASSET || '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  amount: process.env.X402_AMOUNT || '5000',
  facilitator: process.env.X402_FACILITATOR || 'https://facilitator.payai.network',
  chainId: Number(process.env.X402_CHAIN_ID || 84532),
  // EIP-712 domain of the payment token. The facilitator reads the domain
  // from requirements.extra (name/version), NOT from the chain: without
  // extra it fails with invalid_exact_evm_missing_eip712_domain. USDC is
  // "USD Coin"/"2" on Base mainnet but "USDC"/"2" on Base Sepolia.
  tokenName: process.env.X402_TOKEN_NAME || 'USDC',
  tokenVersion: process.env.X402_TOKEN_VERSION || '2',
};

export function encodeHeader(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

export function decodeHeader(value) {
  if (!value || typeof value !== 'string') return null;
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')); } catch { return null; }
}

export function getHeader(req, name) {
  const h = req.headers || {};
  return h[name.toLowerCase()] ?? h[name];
}

// The 402 challenge: what a client must pay to use the paid endpoint.
// x402 v2 PaymentRequirements: { scheme, network, amount, asset, payTo,
// maxTimeoutSeconds, ... }. NOTE: maxAmountRequired is a v1 field —
// including it makes facilitators reject the requirements as v1-shaped.
export function paymentRequired({ payTo, description }) {
  return {
    x402Version: X402_VERSION,
    error: 'Payment Required',
    accepts: [{
      scheme: 'exact',
      network: DEFAULTS.network,
      amount: DEFAULTS.amount,
      asset: DEFAULTS.asset,
      payTo,
      maxTimeoutSeconds: 60,
      description: description || 'Paid on-chain claim verification (ProofCheck, x402)',
      extra: { name: DEFAULTS.tokenName, version: DEFAULTS.tokenVersion },
      facilitator: DEFAULTS.facilitator,
    }],
  };
}

// Read a payment payload from a request (v2 PAYMENT-SIGNATURE, v1 X-PAYMENT fallback).
export function readPaymentPayload(req) {
  const h = getHeader(req, 'PAYMENT-SIGNATURE') || getHeader(req, 'X-PAYMENT');
  return decodeHeader(h);
}

export function payerOf(payment) {
  if (!payment || typeof payment !== 'object') return null;
  const p = payment.payload || {};
  return p.authorization?.from || p.payer || p.from || payment.payer || null;
}

// Verify + settle a payment payload through the facilitator.
// Facilitator API (x402 v2): POST /verify and POST /settle with body
//   { x402Version: 2, paymentPayload, paymentRequirements }
// Before spending a network round trip, the payload is checked locally:
// scheme/network/amount/recipient must match the advertised requirements,
// the EIP-3009 authorization must be unexpired and addressed to payTo.
// Returns { verified, settled, txHash, error } — never throws.
export async function verifyAndSettle(payment, requirements, { timeoutMs = 30000 } = {}) {
  const base = DEFAULTS.facilitator.replace(/\/$/, '');
  // Local pre-checks (no facilitator round trip wasted on a wrong payload).
  const local = localCheck(payment, requirements);
  if (!local.ok) {
    return { verified: false, settled: false, txHash: null, error: local.error };
  }
  const body = JSON.stringify({
    x402Version: X402_VERSION,
    paymentPayload: payment,
    paymentRequirements: requirements,
  });
  async function call(path) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON */ }
      return { status: res.status, ok: res.ok, json, text };
    } finally {
      clearTimeout(t);
    }
  }
  try {
    const v = await call('/verify');
    const isValid = v.json?.isValid === true || v.json?.valid === true;
    if (!v.ok || !isValid) {
      return {
        verified: false, settled: false, txHash: null,
        error: `facilitator verify rejected (HTTP ${v.status}): ${JSON.stringify(v.json ?? v.text).slice(0, 300)}`,
      };
    }
    const s = await call('/settle');
    const txHash = s.json?.transaction || s.json?.txHash || s.json?.transactionHash || null;
    if (!s.ok || (s.json && s.json.success === false)) {
      return {
        verified: true, settled: false, txHash: null,
        error: `facilitator settle failed (HTTP ${s.status}): ${JSON.stringify(s.json ?? s.text).slice(0, 300)}`,
      };
    }
    return { verified: true, settled: true, txHash, error: null, settle: s.json };
  } catch (e) {
    return { verified: false, settled: false, txHash: null, error: `facilitator unreachable: ${e.message}` };
  }
}

// Local payload checks against the advertised requirements. Pure, no I/O.
export function localCheck(payment, req) {
  if (!payment || typeof payment !== 'object') return { ok: false, error: 'empty payment payload' };
  if (payment.x402Version !== 2 && payment.x402Version !== undefined) {
    return { ok: false, error: `unsupported x402Version ${payment.x402Version}` };
  }
  if (payment.scheme && payment.scheme !== 'exact') return { ok: false, error: `unsupported scheme ${payment.scheme}` };
  if (payment.network && req?.network && payment.network !== req.network) {
    return { ok: false, error: `network mismatch: payload ${payment.network} != required ${req.network}` };
  }
  const auth = payment.payload?.authorization;
  if (!auth || typeof auth !== 'object') return { ok: false, error: 'missing EIP-3009 authorization' };
  // v2 payloads echo the requirements entry the client accepted.
  const acc = payment.accepted;
  if (!acc || typeof acc !== 'object') return { ok: false, error: 'missing accepted requirements echo' };
  if (acc.network && req?.network && acc.network !== req.network) {
    return { ok: false, error: `accepted.network ${acc.network} != required ${req.network}` };
  }
  if (acc.payTo && req?.payTo && acc.payTo.toLowerCase() !== req.payTo.toLowerCase()) {
    return { ok: false, error: `accepted.payTo ${acc.payTo} != required ${req.payTo}` };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(auth.from || '')) return { ok: false, error: 'authorization.from is not an address' };
  if (req?.payTo && auth.to?.toLowerCase() !== req.payTo.toLowerCase()) {
    return { ok: false, error: `authorization.to ${auth.to} != payTo ${req.payTo}` };
  }
  if (req?.amount) {
    try {
      if (BigInt(auth.value) < BigInt(req.amount)) {
        return { ok: false, error: `underpayment: ${auth.value} < ${req.amount}` };
      }
    } catch { return { ok: false, error: 'authorization.value is not an integer' }; }
  }
  const now = Math.floor(Date.now() / 1000);
  if (auth.validBefore && Number(auth.validBefore) <= now) {
    return { ok: false, error: 'authorization expired (validBefore in the past)' };
  }
  if (auth.validAfter && Number(auth.validAfter) > now) {
    return { ok: false, error: 'authorization not yet valid (validAfter in the future)' };
  }
  if (!auth.nonce) return { ok: false, error: 'authorization.nonce missing' };
  if (!payment.payload?.signature || typeof payment.payload.signature !== 'string') {
    return { ok: false, error: 'payload.signature missing' };
  }
  return { ok: true };
}

// The PAYMENT-RESPONSE header returned after a settled payment.
export function paymentResponse({ txHash, network }) {
  return encodeHeader({
    success: true,
    transaction: txHash,
    network: network || DEFAULTS.network,
    payer: null,
  });
}
