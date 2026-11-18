// lib/card.js — the agent's public identity documents.
//   - A2A Agent Card: GET /.well-known/agent-card.json
//   - ERC-8004 registration file: GET /.well-known/agent-registration.json
//     (schema: https://eips.ethereum.org/EIPS/eip-8004#registration-v1)
//   - Concordium CIS-8004: the same card is the agent_uri committed
//     on-chain at registration; its SHA-256 becomes the metadata_hash.
//     Until the owner registers (user-side, needs a verified Concordium
//     identity — see REGISTER.md), `registrations` is empty and the
//     concordium block says "pending-registration". Nothing here pretends
//     to be registered: an empty registrations list is the honest state,
//     and verify_agent_card will only match AFTER registration.
import crypto from 'node:crypto';

export const AGENT_NAME = 'GateCheck';
export const AGENT_VERSION = '1.0.0';
export const AGENT_DESCRIPTION =
  'Verify-before-you-believe gatekeeper: checks on-chain claims and ' +
  'counterparty agents before any deal. Deterministic proof-gatekeeper ' +
  'decisions (zkVerify Agent Games heritage) + BSC on-chain verification ' +
  'with receipts + Verified-by-Concordium counterparty checks ' +
  '(CIS-8004 / ERC-8004) before a decision is approved.';

// Concordium extension for the A2A card, following the badge-check
// service's A2A extension form:
// https://docs.concordium.com/a2a-extensions/concordium-badge/v1
export function concordiumBlock({ publicUrl, network, tokenAddress, tokenId }) {
  return {
    extension: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1',
    network: network || 'testnet',
    registry: 'https://agent-registry.concordium.com',
    agentUri: `${publicUrl}/.well-known/agent-card.json`,
    tokenAddress: tokenAddress || null,
    tokenId: tokenId ?? null,
    status: tokenAddress ? 'registered' : 'pending-registration',
    verify: 'Resolve tokenAddress via CIS-8004 agentOf; confirm owner + ' +
      'status is Active + card SHA-256 equals on-chain metadata_hash.',
  };
}

export function buildAgentCard({ publicUrl, network, tokenAddress, tokenId }) {
  const card = {
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    url: publicUrl,
    version: AGENT_VERSION,
    provider: { organization: 'melatim80186', url: 'https://github.com/melatim80186/gatecheck-concordium-agent' },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    authentication: { schemes: [] },
    defaultInputModes: ['text', 'application/json'],
    defaultOutputModes: ['text', 'application/json'],
    skills: [
      {
        id: 'gate_decision',
        name: 'Proof gatekeeper decision',
        description: 'Deterministic APPROVE/REJECT on a task payload: proof reuse, verification-key substitution, balance threshold, expiry, recipient and amount checks (fail closed).',
        tags: ['gatekeeper', 'verification', 'zkverify'],
        examples: ['Decide task {input:{registered_vk, proof_vk, minimum, public_balance, expiry_block, current_block, recipient, condition_recipient, amount, max_transfer, proof_tx}}'],
      },
      {
        id: 'verify_claim',
        name: 'On-chain claim verification',
        description: 'Verify an on-chain claim against public BSC RPC with the receipt attached: NFT ownership, transaction receipt, token supply.',
        tags: ['on-chain', 'bsc', 'verification'],
        examples: ['Does wallet X own NFT #840 of contract C?', 'Did tx 0x… succeed?', 'What is the total supply of contract C?'],
      },
      {
        id: 'check_agent',
        name: 'Verified-by-Concordium counterparty check',
        description: 'Check a counterparty agent in the Concordium Agent Registry (CIS-8004): found, Active, and Agent Card hash matches the on-chain record.',
        tags: ['concordium', 'cis-8004', 'erc-8004', 'trust'],
        examples: ['Is badge Mf22soLh1NuZYFgBK8iSs a verified agent on mainnet?'],
      },
    ],
    concordium: concordiumBlock({ publicUrl, network, tokenAddress, tokenId }),
  };
  return card;
}

export function buildRegistrationFile({ publicUrl, network, tokenAddress, tokenId, cardSha256 }) {
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    image: `${publicUrl}/agent.png`,
    services: [
      { name: 'web', endpoint: `${publicUrl}/` },
      { name: 'A2A', endpoint: `${publicUrl}/.well-known/agent-card.json`, version: '0.3.0' },
      { name: 'MCP', endpoint: `${publicUrl}/mcp`, version: '2025-06-18' },
      { name: 'x402', endpoint: `${publicUrl}/verify-paid`, version: '2' },
    ],
    x402Support: true,
    active: true,
    // Empty until the owner mints the CIS-8004 agent NFT (REGISTER.md).
    // Each entry: { agentId, agentRegistry } — e.g. Concordium testnet
    // CIS-8004 registry contract once registered.
    registrations: tokenAddress
      ? [{ agentId: tokenId ?? null, agentRegistry: `ccd:${network}:cis-8004:${tokenAddress}` }]
      : [],
    supportedTrust: ['reputation'],
    concordium: {
      network: network || 'testnet',
      agentCardSha256: cardSha256,
      note: 'agentCardSha256 is the SHA-256 of /.well-known/agent-card.json; ' +
        'it becomes the CIS-8004 metadata_hash at registration.',
    },
  };
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Build both documents consistently: the registration file embeds the
// card's hash, so register the card FIRST, then the registration payload.
export function buildIdentityDocs(opts) {
  const card = buildAgentCard(opts);
  const cardJson = JSON.stringify(card, null, 2);
  const cardSha256 = sha256Hex(cardJson);
  const registration = buildRegistrationFile({ ...opts, cardSha256 });
  return { card, cardJson, cardSha256, registration };
}
