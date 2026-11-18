// lib/concordium.js — Verified-by-Concordium checks against Concordium's
// PUBLIC endpoints (no keys, no wallet, no account needed to READ):
//   - Badge-check REST (mainnet):
//       GET https://agent-registry-mcp.concordium.com/v1/badge-check/{badge|account}
//       docs: docs.concordium.com/en/mainnet/technical-reference/agent-registry/concordium-badge.html
//   - Hosted Agent Registry MCP (mainnet/testnet/devnet), JSON-RPC over HTTP:
//       POST https://agent-registry-mcp.concordium.com/mcp
//       tools: agent_by_token_address, agents_by_owner, verify_agent_card
//       docs: docs.concordium.com/en/mainnet/technical-reference/agent-registry/mcp-service.html
// A check returns { found, active, cardHashMatches, verified } — the same
// three checks the hackathon brief names (found / active / card matches).
// The on-chain CIS-8004 record itself (register/revoke) lives in the
// official Agent Registry app and needs the owner's verified Concordium
// identity — that step is user-side (see REGISTER.md); this module only
// READS the registry, which any counterparty can do.
export const REGISTRY_BASE = process.env.CONCORDIUM_REGISTRY_BASE ||
  'https://agent-registry-mcp.concordium.com';
export const NETWORKS = ['mainnet', 'testnet', 'devnet'];

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

// Classify a Concordium identifier:
//   - CIS-2 token address (the badge string): short Base58Check, ~12-40 chars
//   - Concordium account address: Base58Check, 50 chars
//   - CAIP-19 form "ccd:<genesis>/cis-2:<short>" reduces to <short>
export function classifyId(input) {
  if (typeof input !== 'string') return { kind: 'invalid', value: String(input) };
  let v = input.trim();
  const caip = v.match(/\/cis-2:([1-9A-HJ-NP-Za-km-z]+)$/);
  if (caip) v = caip[1];
  if (!BASE58.test(v)) return { kind: 'invalid', value: v };
  if (v.length === 50) return { kind: 'account', value: v };
  if (v.length >= 12 && v.length <= 40) return { kind: 'badge', value: v };
  return { kind: 'invalid', value: v };
}

function emptyResult(id, kind, network, source) {
  return {
    id, kind, network, found: false, active: false, cardHashMatches: null,
    verified: false, tokenAddress: kind === 'badge' ? id : null, tokenId: null,
    owner: kind === 'account' ? id : null, agentWallet: null, agentUri: null,
    source, issues: [],
  };
}

function finalize(r) {
  r.verified = Boolean(r.found && r.active && r.cardHashMatches !== false);
  return r;
}

async function fetchJson(url, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    // Tolerate SSE-framed responses ("data: {...}").
    if (!json && (text.startsWith('event:') || text.startsWith('data:'))) {
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      try { json = JSON.parse((line || '').slice(5).trim()); } catch { /* keep null */ }
    }
    return { status: res.status, ok: res.ok, text, json };
  } finally {
    clearTimeout(t);
  }
}

// Call one tool on the hosted Agent Registry MCP server (stateless JSON-RPC).
export async function registryMcpCall(tool, args, { baseUrl = REGISTRY_BASE } = {}) {
  const { status, ok, json } = await fetchJson(`${baseUrl.replace(/\/$/, '')}/mcp`, {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } },
  });
  if (!ok) throw new Error(`registry MCP HTTP ${status}`);
  if (!json || json.error) throw new Error(`registry MCP error: ${json?.error?.message || 'no JSON response'}`);
  const text = json.result?.content?.[0]?.text ?? '';
  if (json.result?.isError) return { isError: true, text };
  try { return { isError: false, data: JSON.parse(text) }; } catch { return { isError: false, data: text }; }
}

// Badge-check REST (mainnet only — the endpoint reports network "mainnet").
async function badgeCheck(value, kind) {
  const r = emptyResult(value, kind, 'mainnet', 'concordium-badge-check');
  const { status, ok, json } = await fetchJson(
    `${REGISTRY_BASE}/v1/badge-check/${encodeURIComponent(value)}`,
  );
  if (!json) throw new Error(`badge-check HTTP ${status} (non-JSON)`);
  if (status === 400 || status === 404) {
    r.issues.push({ severity: 'error', message: json?.message || `badge-check HTTP ${status}` });
    return finalize(r);
  }
  if (!ok) throw new Error(`badge-check HTTP ${status}`);
  if (kind === 'account') {
    const agents = Array.isArray(json.agents) ? json.agents : [];
    const best = agents.find((a) => a.badge_valid) ||
      agents.find((a) => a.on_chain?.status === 'Active') || agents[0];
    r.agentCount = agents.length;
    if (!best) {
      r.issues.push({ severity: 'error', message: 'account owns no CIS-8004 agents' });
      return finalize(r);
    }
    applyBadgeBody(r, best);
    r.owner = value;
    return finalize(r);
  }
  applyBadgeBody(r, json);
  return finalize(r);
}

function applyBadgeBody(r, b) {
  const oc = b.on_chain || {};
  const checks = b.checks || {};
  r.found = Boolean(checks.on_chain_agent_found ?? oc.status);
  r.tokenId = b.token_id ?? null;
  r.tokenAddress = b.token_address || r.tokenAddress;
  r.owner = oc.owner_account || r.owner;
  r.agentUri = b.agent_uri || oc.agent_uri || null;
  r.active = oc.status === 'Active' || checks.status_active === true;
  if ('hash_matches_on_chain' in checks) r.cardHashMatches = Boolean(checks.hash_matches_on_chain);
  r.badgeValid = b.badge_valid ?? null;
  for (const i of b.issues || []) {
    r.issues.push({ severity: i.severity || 'info', message: i.message || String(i) });
  }
  if (r.found && !r.active) r.issues.push({ severity: 'error', message: `agent status is ${oc.status || 'not Active'}` });
}

// Registry lookup via the hosted MCP (testnet/devnet; also works on mainnet).
async function viaMcp(value, kind, network) {
  const r = emptyResult(value, kind, network, 'concordium-mcp');
  let rec;
  if (kind === 'badge') {
    const out = await registryMcpCall('agent_by_token_address', { token_address: value, network });
    if (out.isError) {
      r.issues.push({ severity: 'error', message: String(out.text).slice(0, 300) });
      return finalize(r);
    }
    rec = out.data;
  } else {
    const out = await registryMcpCall('agents_by_owner', { owner_account: value, network, limit: 50 });
    if (out.isError) {
      r.issues.push({ severity: 'error', message: String(out.text).slice(0, 300) });
      return finalize(r);
    }
    const agents = out.data?.agents || [];
    r.agentCount = agents.length;
    rec = agents.find((a) => a.status === 'Active') || agents[0];
    if (!rec) {
      r.issues.push({ severity: 'error', message: 'account owns no CIS-8004 agents' });
      return finalize(r);
    }
  }
  if (!rec || typeof rec !== 'object') return finalize(r);
  r.found = true;
  r.tokenId = rec.token_id_u64 ?? rec.token_id ?? null;
  r.tokenAddress = rec.token_address || r.tokenAddress;
  r.owner = rec.owner_account || null;
  r.agentWallet = rec.agent_wallet || null;
  r.agentUri = rec.agent_uri || null;
  r.active = rec.status === 'Active';
  if (!r.active) r.issues.push({ severity: 'error', message: `agent status is ${rec.status}` });
  if (r.tokenId !== null && r.agentUri) {
    const v = await registryMcpCall('verify_agent_card', { token_id: String(r.tokenId), network });
    if (v.isError) {
      r.issues.push({ severity: 'warning', message: `card check failed: ${String(v.text).slice(0, 200)}` });
    } else {
      r.cardHashMatches = Boolean(v.data?.match);
      if (!r.cardHashMatches) {
        r.issues.push({ severity: 'error', message: 'Agent Card hash does not match on-chain metadata_hash' });
      }
    }
  } else if (r.tokenId !== null) {
    r.cardHashMatches = false;
    r.issues.push({ severity: 'error', message: 'agent has no agent_uri (no Agent Card to verify)' });
  }
  return finalize(r);
}

// Main entry: check an agent's Verified-by-Concordium status.
// network: 'mainnet' (badge-check REST) or 'testnet'/'devnet' (hosted MCP).
export async function checkAgent(input, { network = 'testnet' } = {}) {
  if (!NETWORKS.includes(network)) throw new Error(`unknown network: ${network}`);
  const { kind, value } = classifyId(input);
  if (kind === 'invalid') {
    const r = emptyResult(value, 'badge', network, 'concordium');
    r.issues.push({ severity: 'error', message: 'not a CIS-8004 badge token address or Concordium account address' });
    return finalize(r);
  }
  if (network === 'mainnet') return badgeCheck(value, kind);
  return viaMcp(value, kind, network);
}

// Verify OUR OWN agent card hash against a registry record: fetch the card
// at our agent_uri and compare its SHA-256 to the on-chain metadata_hash.
// (This is what the hosted MCP verify_agent_card tool does server-side;
// this helper lets the demo show the same check locally.)
export async function cardHashMatchesUri(agentUri, expectedHashHex) {
  const { createHash } = await import('node:crypto');
  const res = await fetch(agentUri, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { match: false, reason: `card fetch HTTP ${res.status}` };
  const body = await res.text();
  const hash = createHash('sha256').update(body, 'utf8').digest('hex');
  return { match: hash.toLowerCase() === String(expectedHashHex).toLowerCase(), hash, reason: null };
}
