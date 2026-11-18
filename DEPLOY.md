# Deploy — Render (free tier)

User-side step (~10 minutes). The repo cannot deploy itself: Render
needs the GitHub connection, which only the account owner can grant.

1. Push this repo to GitHub (already done — see repo URL in CHECKPOINT.md).
2. Render dashboard (https://dashboard.render.com) → **New → Blueprint**
   → select the `gatecheck-concordium-agent` repo. `render.yaml` at the
   repo root is a Blueprint: Render auto-detects it and shows the
   `gatecheck-concordium` web service (plan Free, build `npm install`,
   start `npm start`). Click **Apply** / **Deploy Blueprint**.
   (Do NOT use New → Web Service for this repo — that path ignores
   `render.yaml` and needs the build/start commands typed by hand.)
3. When Render prompts for the `sync: false` secret, set:
   - `AGENT_HMAC_SECRET` = a fresh random secret (generate one in the
     dashboard prompt; never commit it). This signs responses with
     `x-agent-games-signature`, the same scheme GateCheck uses. Any
     value works for the demo; keep it secret.
   `AGENT_PUBLIC_URL` and `CONCORDIUM_NETWORK` come from `render.yaml`
   already.
4. Wait for status **Live** (first build takes a few minutes; free tier
   cold-starts take ~30–60 s on first hit after 15 min idle).
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
