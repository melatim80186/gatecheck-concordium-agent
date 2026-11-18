// lib/wallet.js — the agent's OWN throwaway EVM wallet (x402 payTo).
// Generated once at first boot with crypto-random entropy and persisted to
// x402-wallet.json (mode 600) next to server.mjs. This is the AGENT's
// wallet, not the user's: it only ever receives test USDC on Base Sepolia
// from x402 payments, and it holds no mainnet funds. The private key never
// leaves this disk and is never logged. Override with X402_PAY_TO to use a
// different payTo address (the key itself is not needed server-side — the
// facilitator settles, the agent never signs a payment).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWallet } from './eth.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WALLET_FILE = path.join(DIR, '..', 'x402-wallet.json');

export function loadOrCreateWallet() {
  try {
    const raw = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    if (raw && /^0x[0-9a-fA-F]{40}$/.test(raw.address) && raw.privateKey) {
      return { address: raw.address, privateKey: raw.privateKey, created: false };
    }
  } catch { /* no usable wallet file — create one */ }
  const w = generateWallet();
  try {
    fs.writeFileSync(WALLET_FILE, JSON.stringify(w, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(WALLET_FILE, 0o600);
  } catch (e) {
    console.error(`[wallet] WARN could not persist x402-wallet.json: ${e.message}`);
  }
  return { ...w, created: true };
}
