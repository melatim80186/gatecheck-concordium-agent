// lib/proof.js — ProofCheck verification core, unchanged from
// https://github.com/melatim80186/proofcheck-wildcard-agent.
// Checks claims about on-chain facts against public BSC RPC and returns a
// verdict WITH the evidence. Read-only: no keys, no wallet, no funds.
const BSC_RPCS = (process.env.BSC_RPC ? [process.env.BSC_RPC] : [
  'https://bsc-dataseed.binance.org/',
  'https://rpc.ankr.com/bsc',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.bnbchain.org/',
]);

const OWNER_OF = '0x6352211e'; // ownerOf(uint256)
const TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()

let LAST_RPC = BSC_RPCS[0];

function isAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}
function toHex(n) {
  return '0x' + BigInt(n).toString(16);
}
function pad32(hex) {
  return hex.replace(/^0x/, '').padStart(64, '0');
}

async function rpc(method, params) {
  let lastErr;
  for (const url of BSC_RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`RPC ${json.error.code}: ${json.error.message}`);
      LAST_RPC = url;
      return json.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all RPCs failed');
}

async function ethCall(to, data) {
  return rpc('eth_call', [{ to, data }, 'latest']);
}

export async function verifyClaim(c) {
  const checked_at = new Date().toISOString();
  if (!c || typeof c !== 'object' || !c.type) {
    return { verdict: 'invalid', reason: 'missing type', checked_at };
  }

  if (c.type === 'nft-owner') {
    if (!isAddress(c.contract) || !isAddress(c.owner) || c.tokenId === undefined) {
      return { verdict: 'invalid', reason: 'need contract, owner (0x...), tokenId', checked_at };
    }
    const raw = await ethCall(c.contract, OWNER_OF + pad32(toHex(c.tokenId)));
    const actual = '0x' + raw.slice(-40);
    const match = actual.toLowerCase() === c.owner.toLowerCase();
    return {
      verdict: match ? 'verified' : 'refuted',
      claim: { type: c.type, contract: c.contract, tokenId: String(c.tokenId), owner: c.owner },
      evidence: { ownerOf: actual, rpc: LAST_RPC },
      checked_at,
    };
  }

  if (c.type === 'tx') {
    if (typeof c.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(c.hash)) {
      return { verdict: 'invalid', reason: 'need hash (0x + 64 hex)', checked_at };
    }
    const r = await rpc('eth_getTransactionReceipt', [c.hash]);
    if (!r) return { verdict: 'unverified', reason: 'receipt not found (pending or unknown hash)', claim: { type: c.type, hash: c.hash }, checked_at };
    return {
      verdict: r.status === '0x1' ? 'verified' : 'refuted',
      claim: { type: c.type, hash: c.hash },
      evidence: { status: r.status, blockNumber: r.blockNumber, from: r.from, to: r.to, gasUsed: r.gasUsed, rpc: LAST_RPC },
      checked_at,
    };
  }

  if (c.type === 'supply') {
    if (!isAddress(c.contract)) {
      return { verdict: 'invalid', reason: 'need contract (0x...)', checked_at };
    }
    const raw = await ethCall(c.contract, TOTAL_SUPPLY);
    return {
      verdict: 'verified',
      claim: { type: c.type, contract: c.contract },
      evidence: { totalSupply: String(BigInt(raw)), totalSupplyHex: raw, rpc: LAST_RPC },
      checked_at,
    };
  }

  return { verdict: 'invalid', reason: `unknown type "${c.type}" (nft-owner | tx | supply)`, checked_at };
}
