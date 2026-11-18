// lib/a2a.js — minimal A2A (Agent2Agent) JSON-RPC surface over POST /a2a.
// Implements the subset the demo needs:
//   message/send  — run one agent skill from a text part and return an artifact
//   tasks/get     — fetch a completed task by id
//   tasks/cancel  — completed tasks cannot be cancelled (honest error)
// The full A2A spec (streaming, push notifications, file parts) is out of
// scope; this is a documented minimal subset, not a full implementation.
// The A2A Agent Card itself lives at GET /.well-known/agent-card.json.
import { checkAgent } from './concordium.js';
import { verifyClaim } from './proof.js';
import { decide } from './gate.js';

const tasks = new Map();
let seq = 0;

function textOf(message) {
  const parts = message?.parts || [];
  return parts.filter((p) => p.kind === 'text' || p.type === 'text')
    .map((p) => p.text || '').join('\n').trim();
}

async function runSkill(text, ctx) {
  // The message text is JSON: { skill, ...args }.
  let req;
  try { req = JSON.parse(text); } catch {
    return { error: 'message text must be JSON: {skill:"check_agent"|"verify_claim"|"gate_decision", ...args}' };
  }
  if (req.skill === 'check_agent') {
    if (typeof req.id !== 'string') return { error: 'check_agent needs {id}' };
    return await checkAgent(req.id, { network: req.network || 'testnet' });
  }
  if (req.skill === 'verify_claim') return await verifyClaim(req);
  if (req.skill === 'gate_decision') {
    if (!req.task) return { error: 'gate_decision needs {task}' };
    return decide({ ...req.task, _seen: ctx.seen });
  }
  return { error: `unknown skill "${req.skill}" (check_agent | verify_claim | gate_decision)` };
}

export async function handleA2a(body, ctx) {
  if (!body || typeof body !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { method, params, id } = body;
  try {
    if (method === 'message/send') {
      const text = textOf(params?.message);
      if (!text) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'message needs at least one text part' } };
      }
      const result = await runSkill(text, ctx);
      const taskId = `task-${++seq}-${Date.now().toString(36)}`;
      const task = {
        id: taskId,
        contextId: params?.message?.contextId || taskId,
        status: { state: result.error ? 'failed' : 'completed', timestamp: new Date().toISOString() },
        artifacts: [{
          artifactId: `artifact-${taskId}`,
          name: 'result',
          parts: [{ kind: 'text', text: JSON.stringify(result, null, 2) }],
        }],
        kind: 'task',
      };
      tasks.set(taskId, task);
      return { jsonrpc: '2.0', id, result: task };
    }
    if (method === 'tasks/get') {
      const t = tasks.get(params?.id);
      if (!t) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown task ${params?.id}` } };
      return { jsonrpc: '2.0', id, result: t };
    }
    if (method === 'tasks/cancel') {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: 'completed tasks cannot be cancelled' } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } };
  }
}
