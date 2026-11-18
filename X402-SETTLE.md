# x402 live settle — status + exact steps

## Status (re-verified 2026-11-19, this run)

- `npm test` 49/49 PASS — the facilitator verify path is proven live: a
  properly signed EIP-3009 authorization is accepted as cryptographically
  valid (signature recovers to the payer, EIP-712 domain USDC/2 matches)
  and rejected **only** with `invalid_exact_evm_insufficient_balance`.
- **On-chain settle NOT yet proven** — the only missing piece is a funded
  payer. The settle code path is the same facilitator call shape as the
  proven verify path (`POST /settle` after `POST /verify` in `lib/x402.js`).

## The payer (agent-side, ready)

- Persistent throwaway payer: `x402-payer.json` (mode 600, gitignored —
  the key is never printed, never committed, never leaves this VM).
- **Payer address (public — this is what gets funded):**
  `0xe6e139d5292efd5ffb63347b33b6fc13dd7feab8`
- Balance checked on-chain 2026-11-19 ~19:30 WIB via public Base Sepolia
  RPC: **0.000000 USDC, 0.000000 ETH**. The payer needs no ETH at all:
  under the x402 `exact` scheme the facilitator submits the transfer and
  pays the gas — only test USDC is needed.

## User step: fund the payer (free, ~2 minutes)

1. Open https://faucet.circle.com (Circle's public testnet faucet — no
   account needed, 20 test USDC per request, once per address+network
   every 2 hours).
2. Select **USDC** and network **Base Sepolia** (chain ID 84532).
3. Paste the payer address:
   `0xe6e139d5292efd5ffb63347b33b6fc13dd7feab8`
4. Submit. 20 test USDC arrives (testnet token, no real value).
   The demo spends only **$0.005** of it; the rest stays in the throwaway.

Alternative (also free, no account): Coinbase CDP faucet gives 1 USDC
per claim on Base Sepolia (up to 10 claims / 24h) — Circle is simpler.

## Agent step after funding (no user action needed)

From the work dir:

```bash
cd ~/workspace/bug-bounty/makefun/hackathon-push/concordium
node settle-probe.mjs
```

- If the payer is still unfunded, the script prints the faucet link and
  exits without spending anything.
- If funded, it signs the $0.005 EIP-3009 authorization, POSTs
  `/verify-paid` to a local server, and prints the settle `txHash` +
  Basescan link. That txHash is the on-chain proof the README's x402
  section can then honestly claim, and it belongs in the demo video.

## Why not just use the already-funded Base wallet?

The Base Stocks wallet (`0xF345…1357`, 0.075 Base Sepolia ETH) holds
**ETH, not USDC** — it cannot pay an x402 `exact` USDC authorization.
Swapping its ETH for USDC would move the user's funds through a DEX;
that is out of scope for this agent run. The Circle faucet route above
is free, takes 2 minutes, and touches nothing the user already owns.
