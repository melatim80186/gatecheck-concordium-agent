// lib/gate.js — GateCheck decision core, unchanged from the zkVerify
// Agent Games Gatekeeper (https://github.com/melatim80186/gatecheck-gatekeeper-agent).
// Deterministic trap checks in platform order (first hit wins). Pure: no
// network, no keys. Fail closed on missing / malformed fields.
export function normAddr(a) {
  return typeof a === 'string' ? a.trim().toLowerCase() : '';
}

export function toBig(v) {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
    return null;
  } catch { return null; }
}

export function decide(task) {
  const input = (task && typeof task === 'object' &&
    task.input && typeof task.input === 'object') ? task.input : {};
  const proofTx = typeof input.proof_tx === 'string' && input.proof_tx ? input.proof_tx : null;

  // 1) PROOF_REUSED
  if (proofTx && task._seen && task._seen.has(proofTx)) {
    return { decision: 'REJECT', reason_code: 'PROOF_REUSED', proof_tx: proofTx };
  }
  // 2) VK_SUBSTITUTION
  const regVk = typeof input.registered_vk === 'string' ? input.registered_vk.trim().toLowerCase() : '';
  const proofVk = typeof input.proof_vk === 'string' ? input.proof_vk.trim().toLowerCase() : '';
  if (!regVk || !proofVk || regVk !== proofVk) {
    return { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION', proof_tx: proofTx };
  }
  // 3) THRESHOLD_MISMATCH
  const bal = toBig(input.public_balance);
  const min = toBig(input.minimum);
  if (bal === null || min === null || bal < min) {
    return { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH', proof_tx: proofTx };
  }
  // 4) EXPIRED_CONDITION
  const cur = toBig(input.current_block);
  const exp = toBig(input.expiry_block);
  if (cur === null || exp === null || cur > exp) {
    return { decision: 'REJECT', reason_code: 'EXPIRED_CONDITION', proof_tx: proofTx };
  }
  // 5) RECIPIENT_MISMATCH
  const recip = normAddr(input.recipient);
  const condRecip = normAddr(input.condition_recipient);
  if (!recip || !condRecip || recip !== condRecip) {
    return { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH', proof_tx: proofTx };
  }
  // 6) AMOUNT_OVERFLOW
  const amt = toBig(input.amount);
  const max = toBig(input.max_transfer);
  if (amt === null || max === null || amt > max) {
    return { decision: 'REJECT', reason_code: 'AMOUNT_OVERFLOW', proof_tx: proofTx };
  }
  // 7) All checks pass.
  return { decision: 'APPROVE', reason_code: 'VALID_CONDITION', proof_tx: proofTx };
}
