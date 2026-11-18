# Deploy — Render (free tier)

User-side step (~10 minutes). The repo cannot deploy itself: Render
needs the GitHub connection, which only the account owner can grant.

1. Push this repo to GitHub (already done — see repo URL in CHECKPOINT.md).
2. Render dashboard → **New → Web Service** → connect the
   `gatecheck-concordium-agent` repo. `render.yaml` is auto-detected.
3. Plan: **Free**. Build: `npm install`. Start: `npm start`.
4. Environment variables (Render → Environment):
   - `AGENT_PUBLIC_URL` = `https://gatecheck-concordium.onrender.com`
     (already in `render.yaml`)
   - `CONCORDIUM_NETWORK` = `testnet` (already in `render.yaml`)
   - `AGENT_HMAC_SECRET` = a fresh random secret (generate one;
     `sync: false` — set it in the dashboard, never commit it).
     This signs responses with `x-agent-games-signature`, the same
     scheme GateCheck uses. Any value works for the demo; keep it
     secret.
5. Deploy, then smoke-test:
   ```bash
   curl https://gatecheck-concordium.onrender.com/health
   curl https://gatecheck-concordium.onrender.com/.well-known/agent-card.json
   curl "https://gatecheck-concordium.onrender.com/check-agent?id=Mf22soLh1NuZYFgBK8iSs&network=mainnet"
   ```
   (Free tier cold-starts take ~30–60 s on first hit.)
6. After CIS-8004 registration (REGISTER.md), add
   `CONCORDIUM_TOKEN_ADDRESS` + `CONCORDIUM_TOKEN_ID` in the dashboard
   and redeploy — the card and `GET /info` will report `registered`.

Notes:
- The agent's x402 wallet (`x402-wallet.json`) is generated on first
  boot on the Render disk. Render free-tier disk is ephemeral across
  deploys, so the payTo address can change after a redeploy — that is
  fine (it only receives test USDC), but re-check `GET /info` for the
  current `x402.payTo` after a redeploy. To pin it, set `X402_PAY_TO`
  explicitly.
- `seen.json` (proof-reuse memory) and `audit.jsonl` are also
  ephemeral on the free tier — same caveat as GateCheck, documented in
  its README.
