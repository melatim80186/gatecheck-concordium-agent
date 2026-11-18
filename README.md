# GateCheck — Concordium Trusted Agents Hackathon (Encode Club)

**Verify-before-you-believe gatekeeper, made accountable.** An agent you
already run — GateCheck (zkVerify Agent Games Proof Gatekeeper) +
ProofCheck (on-chain claim verification) — extended with everything the
[Concordium Trusted Agents Hackathon](https://www.concordium.com/article/concordium-trusted-agents-hackathon-encode-club)
asks for: Verified-by-Concordium counterparty checks, an ERC-8004 Agent
Card + Agent Registry entry, x402 agent payments, and MCP/A2A.

- **Deadline:** 9 Dec 2026, 23:59 UTC · **Checkpoint 1:** 22 Nov 2026
  (project, team, idea — see [CHECKPOINT.md](CHECKPOINT.md))
- **Cost:** free. Testnet only. No cash prize pool is published for this
  hackathon — the value is the path into Concordium's 75M CCD grants
  programme (see [Honest scope](#honest-scope) below).
- **Stack:** Node 22 stdlib only — **zero dependencies**, runs anywhere.

## What it does

A counterparty agent wants to deal with you. Before GateCheck approves
anything, it checks three things that used to be taken on trust:

1. **Is the counterparty a verified agent?** Its Verified-by-Concordium
   badge is checked live against the Concordium Agent Registry
   (CIS-8004): found on-chain, status Active, and its published Agent
   Card hash matches the on-chain record. Unverified → `REJECT /
   AGENT_UNVERIFIED`, before any other check runs.
2. **Is the claim true?** NFT ownership, transaction receipts and token
   supply are verified against public BSC RPC, with the receipt attached
   — never on trust (ProofCheck heritage).
3. **Is the task itself clean?** The deterministic GateCheck trap matrix
   (proof reuse, VK substitution, balance threshold, expiry, recipient,
   amount — fail closed) decides APPROVE / REJECT.

Plus: a hash-chained audit trail of every decision (EU AI Act
record-keeping), an ERC-8004 registration file + A2A agent card, an MCP
server, a minimal A2A surface, and a paid verification tier over x402.

## What changed from GateCheck / ProofCheck

| From | Kept as-is | New here |
|---|---|---|
| GateCheck (`gatecheck-gatekeeper-agent`) | Trap matrix, HMAC signing (`x-agent-games-signature`, bare hex), preflight handshake, seen-set, fail-closed | Counterparty badge gate (check 0: `AGENT_UNVERIFIED`) |
| ProofCheck (`proofcheck-wildcard-agent`) | BSC `eth_call` / receipt verification (`nft-owner`, `tx`, `supply`), multi-RPC fallback | Paid tier `POST /verify-paid` (x402) |
| — | — | `GET /check-agent` (live CIS-8004 check), `/.well-known/agent-card.json` (A2A) + `/.well-known/agent-registration.json` (ERC-8004), `POST /mcp`, `POST /a2a`, `GET /audit`, `GET /agent.png` |

## Endpoints

| Route | What it does |
|---|---|
| `GET /`, `/health`, `/agent` | Protocol-v1 health check `{"ok":true,"protocolVersion":"v1"}` |
| `GET /info` | Agent card summary, Concordium status, x402 terms |
| `GET /.well-known/agent-card.json` | A2A Agent Card (served byte-exact — its SHA-256 is the CIS-8004 `metadata_hash`) |
| `GET /.well-known/agent-registration.json` | ERC-8004 registration file (`registration-v1`) |
| `GET /agent.png` | Agent icon (generated PNG, 128×128) |
| `GET /check-agent?id=<badge\|account>&network=testnet\|mainnet\|devnet` | Live Verified-by-Concordium check |
| `GET /concordium` | Registration status + agent URI + card SHA-256 |
| `POST /`, `/task`, `/agent` | GateCheck task → APPROVE/REJECT (+ `badge` field) |
| `POST /verify` | Free on-chain claim verification |
| `POST /verify-paid` | Paid verification — x402 (see below) |
| `POST /mcp` | MCP Streamable HTTP: `check_agent`, `verify_claim`, `gate_decision`, `audit_status` |
| `POST /a2a` | Minimal A2A JSON-RPC: `message/send`, `tasks/get` |
| `GET /audit?limit=N` | Hash-chained audit trail + chain verification |

### Counterparty gate — the one new decision rule

```bash
curl -X POST http://127.0.0.1:8080/task -H 'content-type: application/json' -d '{
  "task_id": "demo", "input": {
    "registered_vk": "0x7d3a...f291", "proof_vk": "0x7d3a...f291",
    "minimum": "1000", "public_balance": "1460",
    "expiry_block": 19842201, "current_block": 19832000,
    "recipient": "0xDe42...9f01", "condition_recipient": "0xDe42...9f01",
    "amount": "500", "max_transfer": "1000",
    "proof_tx": "0xabc...001",
    "counterparty_badge": "Mf22soLh1NuZYFgBK8iSs",
    "counterparty_network": "mainnet"
  }
}'
# verified counterparty -> {"decision":"APPROVE","reason_code":"VALID_CONDITION","badge":{"checked":true,"verified":true,...}}
# unverified counterparty -> {"decision":"REJECT","reason_code":"AGENT_UNVERIFIED",...}
```

The check reads Concordium's public endpoints — badge-check REST
(mainnet) and the hosted Agent Registry MCP (testnet/devnet). No keys,
no wallet, no account needed to *read* the registry.

### x402 paid verification — status, honestly

`POST /verify-paid` answers **HTTP 402** with a `PAYMENT-REQUIRED`
challenge (x402 v2, `exact` scheme, Base Sepolia USDC, **$0.005** per
verification, payTo = the agent's own wallet). With a signed
EIP-3009 authorization in `PAYMENT-SIGNATURE`, the server runs local
checks, then verifies + settles via the PayAI facilitator and returns
the verdict with a `PAYMENT-RESPONSE` receipt.

**What is proven live (2026-11-18, in `npm test`):** the full verify
path against the real facilitator — a properly signed EIP-3009
authorization from a throwaway payer is accepted as cryptographically
valid (signature recovers to the payer, EIP-712 domain `USDC`/`2`
matches) and rejected *only* with
`invalid_exact_evm_insufficient_balance`, because the throwaway holds
no test USDC. **What is NOT yet proven:** an actual on-chain
settlement, which needs a payer holding Base Sepolia USDC (Circle
testnet faucet — a user-side step, see below). The settle code path is
implemented and uses the identical facilitator call shape as the
proven verify path; nothing here pretends a settlement happened.

Malformed claims are rejected with 400 **before** any settlement, so
nobody pays for an unparseable request.

## Run it

```bash
npm test        # full suite: 49 checks, incl. live Concordium + BSC + facilitator
npm start       # PORT=8080 by default
```

Env: `PORT`, `AGENT_HMAC_SECRET`, `AGENT_PUBLIC_URL`
(default `http://127.0.0.1:PORT`), `CONCORDIUM_NETWORK` (default
`testnet`), `CONCORDIUM_TOKEN_ADDRESS` / `CONCORDIUM_TOKEN_ID` (set
after registration, see [REGISTER.md](REGISTER.md)), `X402_PAY_TO`
(default: the agent's own throwaway wallet, generated at first boot
into `x402-wallet.json`, mode 600 — agent-owned, testnet only),
`BSC_RPC`.

## Deploy

Render free tier — see [DEPLOY.md](DEPLOY.md) (connect the repo,
`render.yaml` is auto-detected, set `AGENT_HMAC_SECRET`).

## Honest scope

- **No cash prize is published for this hackathon.** The official page
  offers winners a pitch into Concordium's 75M CCD grants programme
  ("grants go to projects with real usage rather than the best pitch").
  This entry is worth it as a *real, working* Concordium integration
  on top of agents that already run live — not as a cash chase.
- **On-chain CIS-8004 registration is NOT done by this repo.** Minting
  the agent NFT requires the owner's verified Concordium identity
  (passport/liveness via Concordium Wallet) — that is inherently
  user-side, and this agent must never hold the user's identity. The
  repo ships everything registration needs (agent URI + card SHA-256 +
  step-by-step [REGISTER.md](REGISTER.md)); until then the card honestly
  reports `pending-registration` with an empty `registrations` list.
- **x402 settlement** is code-complete and verify-proven; live
  settlement awaits a funded test payer (see above).
- **A2A is a minimal subset** (`message/send`, `tasks/get`) — streaming
  and push notifications are out of scope and documented as such in
  `lib/a2a.js`.
- **Concordium-native x402 settlement** (paying in CCD / on Concordium
  rails) is a future step once a public Concordium facilitator exists;
  today the x402 rail is Base Sepolia USDC, the canonical demo rail.

## Files

| File | What it is |
|---|---|
| `server.mjs` | The agent. Node 22 stdlib only, zero dependencies. |
| `lib/gate.js` | GateCheck trap matrix (from GateCheck). |
| `lib/proof.js` | ProofCheck BSC verification (from ProofCheck). |
| `lib/concordium.js` | Badge-check REST + hosted MCP client (live registry reads). |
| `lib/card.js` | A2A card + ERC-8004 registration file + card SHA-256. |
| `lib/x402.js` | x402 v2: 402 challenge, local checks, facilitator verify/settle. |
| `lib/eth.js` | Pure-JS keccak256 + secp256k1 sign/recover + EIP-712 (stdlib has no keccak). |
| `lib/mcp.js` | MCP server (tools: check_agent, verify_claim, gate_decision, audit_status). |
| `lib/a2a.js` | Minimal A2A JSON-RPC surface. |
| `lib/audit.js` | Hash-chained JSONL audit trail. |
| `lib/wallet.js` | Agent's own throwaway EVM wallet (x402 payTo). |
| `lib/icon.js` | PNG encoder for `/agent.png`. |
| `test-local.mjs` | 49-check suite (`npm test`), incl. live registry/BSC/facilitator. |
| `CHECKPOINT.md` | Checkpoint 1 (22 Nov) material: project, team, idea. |
| `REGISTER.md` | User-side CIS-8004 registration steps. |
| `DEPLOY.md` | Render deploy steps. |
