# Registering GateCheck in the Concordium Agent Registry (CIS-8004)

This is the **user-side** part. Minting the CIS-8004 agent NFT requires
the owner's verified Concordium identity — passport + liveness via the
Concordium Wallet. An agent must never hold the user's identity, so this
step cannot be automated. Everything the registration needs is already
prepared by the repo.

## What the repo already provides

After deploying (see DEPLOY.md), the agent serves:

- **Agent URI:** `https://gatecheck-concordium.onrender.com/.well-known/agent-card.json`
- **Card SHA-256 (metadata_hash):** shown at `GET /info` and
  `GET /concordium` as `agentCardSha256` (also embedded in the
  ERC-8004 registration file at
  `/.well-known/agent-registration.json`).
- The card is served **byte-exact**, so the hash the registry commits
  matches what `verify_agent_card` fetches later. Do not edit the card
  after registering without updating the on-chain hash (`setAgentURI`).

## Steps (user, ~15 minutes + identity verification time)

1. **Install Concordium Wallet** (browser extension or mobile) and
   create a **testnet** identity. Testnet identities use the test
   identity provider — no real documents are needed on testnet.
2. **Get free test CCD** from the testnet faucet
   (linked from the wallet / docs.concordium.com) to your testnet
   account.
3. **Open the Agent Registry app:** https://agent-registry.concordium.com
   — switch the network to **testnet**, connect the wallet.
4. **Register the agent:**
   - Name: `GateCheck`
   - Agent URI: `https://gatecheck-concordium.onrender.com/.well-known/agent-card.json`
   - The app computes the card hash from the URI; confirm it equals
     the `agentCardSha256` from `GET /concordium`.
   - Submit (test CCD only, free).
5. **Note the result:** the CIS-2 token address (the badge string,
   e.g. `Mf22...`) and the token ID.
6. **Wire it into the deployment** (Render → Environment):
   - `CONCORDIUM_TOKEN_ADDRESS=<badge token address>`
   - `CONCORDIUM_TOKEN_ID=<token id>`
   - Redeploy. `GET /info` and the agent card will now report
     `status: registered`, and the registration file will list the
     registration.
7. **Verify it from the outside** (anyone can do this, no login):
   ```bash
   curl "https://gatecheck-concordium.onrender.com/check-agent?id=<badge>&network=testnet"
   # -> {"found":true,"active":true,"cardHashMatches":true,"verified":true,...}
   ```
   The hosted MCP `verify_agent_card` tool should also report a match.

## After registration

- The badge is the agent's **Verified by Concordium** badge: other
  agents can check it before dealing with GateCheck, and GateCheck's
  own counterparty gate (`AGENT_UNVERIFIED`) already enforces the same
  check in the other direction.
- Cross-chain linking (optional, later): CIS-8 External Key Registry
  can bind the agent to its existing Ethereum/BSC keys, so the same
  badge covers the chains GateCheck already works on. Not required for
  the hackathon submission.
- If the agent card ever changes, update the on-chain URI/hash
  (`setAgentURI`) or verification will report a hash mismatch — by
  design.
