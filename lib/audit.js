// lib/audit.js — hash-chained append-only audit trail (EU AI Act
// record-keeping story: every decision / verification / payment is logged
// with a SHA-256 chain so tampering is detectable).
// Best-effort persistence like GateCheck's seen.json: a failed disk write
// never breaks a decision. GET /audit returns entries + chainOk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_FILE = path.join(DIR, '..', 'audit.jsonl');

const entries = [];
let lastHash = '0'.repeat(64);

try {
  const raw = fs.readFileSync(AUDIT_FILE, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      entries.push(e);
      lastHash = e.hash;
    } catch { /* skip corrupt line */ }
  }
} catch { /* no audit file yet */ }

function appendToDisk(entry) {
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error(`[audit] WARN could not persist audit entry: ${e.message}`);
  }
}

export function log(kind, summary) {
  const entry = {
    seq: entries.length + 1,
    ts: new Date().toISOString(),
    kind,
    summary,
    prev: lastHash,
  };
  entry.hash = crypto.createHash('sha256')
    .update(`${entry.seq}|${entry.ts}|${entry.kind}|${JSON.stringify(entry.summary)}|${entry.prev}`)
    .digest('hex');
  entries.push(entry);
  lastHash = entry.hash;
  appendToDisk(entry);
  return entry;
}

export function verifyChain() {
  let prev = '0'.repeat(64);
  for (const e of entries) {
    const expect = crypto.createHash('sha256')
      .update(`${e.seq}|${e.ts}|${e.kind}|${JSON.stringify(e.summary)}|${e.prev}`)
      .digest('hex');
    if (e.prev !== prev || e.hash !== expect) return { ok: false, brokenAt: e.seq };
    prev = e.hash;
  }
  return { ok: true, count: entries.length };
}

export function recent(limit = 50) {
  return entries.slice(-limit);
}
