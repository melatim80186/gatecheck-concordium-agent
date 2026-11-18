# Checkpoint 1 — 22 Nov 2026: project, team, idea

## Project

**GateCheck — a verify-before-you-believe gatekeeper, made accountable
with Concordium.**

Repo: https://github.com/melatim80186/gatecheck-concordium-agent
Live demo: https://gatecheck-concordium.onrender.com (after deploy — see DEPLOY.md)

## Team

Solo: Southern (builder) + AI agent builder. One agent codebase, two
live ancestors: GateCheck (zkVerify Agent Games, Proof Gatekeeper —
live on Render, preflight-passing) and ProofCheck (Wildcard — live on
Render, BSC on-chain verification).

## Idea (one paragraph)

Agents already sign up, pay and deal with each other — but they take
counterparties and claims on trust. GateCheck closes that gap: before
it approves any task, it checks the counterparty's Verified-by-
Concordium badge live against the Concordium Agent Registry (CIS-8004:
found, Active, Agent Card hash matches on-chain) and verifies the
underlying on-chain facts against public RPC with receipts attached.
It carries its own ERC-8004 Agent Card + registration file (the card
hash becomes the CIS-8004 metadata_hash at registration), sells its
paid verification tier over x402 ($0.005, Base Sepolia USDC), exposes
its skills over MCP and A2A, and logs every decision to a hash-chained
audit trail for EU AI Act record-keeping. The demo flow: unverified
counterparty → REJECT AGENT_UNVERIFIED; verified counterparty + true
claim → APPROVE with evidence.

## Status at checkpoint

- [x] Agent running locally; `npm test` 49/49 PASS (live Concordium
  badge-check + hosted MCP, live BSC verification, live x402
  facilitator verify — signature + EIP-712 domain proven, only
  balance missing on the unfunded throwaway payer).
- [x] ERC-8004 registration file + A2A card + card SHA-256; MCP (4
  tools) + minimal A2A; hash-chained audit trail.
- [ ] Render deploy (user step — connect repo, set env; 10 min).
- [ ] CIS-8004 on-chain registration (user step — needs the owner's
  verified Concordium testnet identity; REGISTER.md).
- [ ] Funded Base Sepolia USDC payer for a live x402 settle demo
  (user step — Circle testnet faucet).
- [ ] Demo video (≤3 min) + submission (due 9 Dec 23:59 UTC).

## Why this fits the brief

- **Bring an agent you already run:** GateCheck + ProofCheck are live
  in production (Render) since the zkVerify Agent Games, not built for
  this hackathon.
- **Meaningful use of Concordium components:** live reads of the Agent
  Registry (badge-check REST + hosted MCP), CIS-8004 card/hash
  commitment, Verified-by-Concordium gating as a core decision rule —
  not a logo.
- **Real problem:** agent-to-agent trust before payment/delegation;
  the audit trail maps to EU AI Act record-keeping, one of the five
  suggested starting points.
- **Route to mainnet + real users:** the same gate can front any paid
  API (x402) — reject unverified agents before they reach the paywall.
