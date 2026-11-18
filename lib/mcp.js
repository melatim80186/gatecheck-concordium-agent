// lib/mcp.js — MCP server (Streamable HTTP, JSON-RPC 2.0) over POST /mcp.
// Tools:
//   check_agent   { id, network? }            -> Verified-by-Concordium check
//   verify_claim  { type, ... }               -> ProofCheck on-chain verdict
//   gate_decision { task }                    -> GateCheck APPROVE/REJECT
//   audit_status  {}                          -> audit chain verification
// No SDK: the protocol surface here is small (initialize, ping,
// tools/list, tools/call) and implemented directly. Notifications and
// unknown methods get a proper JSON-RPC error, never a crash.
import { checkAgent } from './concordium.js';
import { verifyClaim } from './proof.js';
import { decide } from './gate.js';
import { verifyChain, recent } from './audit.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'gatecheck-concordium', version: '1.0.0' };

export const TOOLS = [
  {
    name: 'check_agent',
    description: 'Check a counterparty agent in the Concordium Agent Registry (CIS-8004): found, Active, and Agent Card hash matches the on-chain record. id is a CIS-2 badge token address or a Concordium account address; network is mainnet, testnet (default) or devnet.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'CIS-8004 badge token address or Concordium account address' },
        network: { type: 'string', enum: ['mainnet', 'testnet', 'devnet'], default: 'testnet' },
      },
      required: ['id'],
    },
  },
  {
    name: 'verify_claim',
    description: 'Verify an on-chain claim against public BSC RPC and return the verdict with evidence. Types: nft-owner {contract, tokenId, owner}, tx {hash}, supply {contract}.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['nft-owner', 'tx', 'supply'] },
        contract: { type: 'string' },
        tokenId: { type: ['string', 'number'] },
        owner: { type: 'string' },
        hash: { type: 'string' },
      },
      required: ['type'],
    },
  },
  {
    name: 'gate_decision',
    description: 'Deterministic gatekeeper decision on a task payload (proof reuse, VK substitution, balance threshold, expiry, recipient, amount). Returns APPROVE/REJECT with a reason code; fails closed.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'object', description: 'GateCheck task payload {task_id?, input:{...}}' } },
      required: ['task'],
    },
  },
  {
    name: 'audit_status',
    description: 'Verify the hash-chained audit trail and return recent entries.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 10 } } },
  },
];

function toolResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

async function callTool(name, args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'check_agent') {
    if (typeof a.id !== 'string' || !a.id) throw new Error('check_agent needs {id}');
    return toolResult(await checkAgent(a.id, { network: a.network || 'testnet' }));
  }
  if (name === 'verify_claim') {
    return toolResult(await verifyClaim(a));
  }
  if (name === 'gate_decision') {
    if (!a.task || typeof a.task !== 'object') throw new Error('gate_decision needs {task}');
    const out = decide({ ...a.task, _seen: ctx.seen });
    return toolResult(out);
  }
  if (name === 'audit_status') {
    return toolResult({ chain: verifyChain(), recent: recent(Number(a.limit) || 10) });
  }
  throw new Error(`unknown tool "${name}"`);
}

export async function handleMcp(body, ctx) {
  if (!body || typeof body !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { method, params, id } = body;
  // Notifications (no id) are acknowledged with no body.
  if (id === undefined) return null;
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    if (method === 'tools/call') {
      const out = await callTool(params?.name, params?.arguments || {}, ctx);
      return { jsonrpc: '2.0', id, result: out };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } };
  }
}
