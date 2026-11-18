# Demo video — outline + script (≤ 3 minutes)

Target: max 3:00, narrated screen recording. Record only AFTER the Render
deploy is live (DEPLOY.md) — every shot below needs the public URL
`https://gatecheck-concordium.onrender.com`. If CIS-8004 registration is
done by then, the badge check at the end shows `registered`; if not, the
card honestly shows `pending-registration` — say so on camera, do not
fake it.

## Shot list (total ≈ 2:40)

| # | Time | What to show | Narration (EN, calm) |
|---|------|--------------|----------------------|
| 1 | 0:00–0:20 | Browser: `GET /health` + `GET /info` on the Render URL. | "GateCheck is a gatekeeper agent I already run. For the Concordium hackathon I taught it to check who it deals with before it approves anything." |
| 2 | 0:20–0:50 | Terminal: `curl /check-agent?id=<our badge>&network=testnet` → `verified: true`. Then a bogus badge → `verified: false`. | "Every counterparty is checked live against the Concordium Agent Registry — found, Active, and its Agent Card hash matches on-chain. Unverified agents are rejected before any other check runs." |
| 3 | 0:50–1:20 | Terminal: `POST /task` with an unverified counterparty → `REJECT / AGENT_UNVERIFIED`. Same task with a verified badge → `APPROVE`. | "That check is a decision rule, not a logo. Same task, same claim — the only difference is the badge. Unverified: rejected. Verified: approved with evidence." |
| 4 | 1:20–1:50 | Terminal: `POST /verify` (free BSC claim check, receipt attached) + `GET /audit` (hash-chained trail). | "Claims are verified against public RPC with receipts attached, never taken on trust — and every decision lands in a hash-chained audit trail, for EU AI Act record-keeping." |
| 5 | 1:50–2:20 | Terminal: `POST /verify-paid` without payment → HTTP 402 + challenge; then (only if the settle demo is done, X402-SETTLE.md) the settled payment + Basescan tx. | "The paid tier runs on x402 — five thousandths of a dollar per verification, settled on Base Sepolia. [If settled:] here is the on-chain settlement." |
| 6 | 2:20–2:40 | Browser: `/.well-known/agent-card.json` (A2A card) + `/.well-known/agent-registration.json` (ERC-8004) + MCP `tools/list` (4 tools). | "It publishes an ERC-8004 Agent Card and registration file, and exposes its skills over MCP and A2A — so other agents can check it the same way it checks them." |

## Closing line (on camera or voice-over, 2:40–2:50)

"GateCheck: verify before you believe — with a verified human behind it.
Repo and live demo in the description."

## Recording notes

- 1080p, terminal font large enough to read at video size; zoom the
  browser to 125% so JSON is legible.
- Free-tier cold start: hit `/health` once ~60 s before recording so the
  service is warm; every curl after that is fast.
- Keep each curl in a text file and paste — no live typing mistakes.
- Export as MP4 ≤ 3 min; upload unlisted to YouTube (or as required by
  the Encode submission form) and paste the link into the final
  submission (deadline 9 Dec 23:59 UTC).
- Do NOT record the Render dashboard, the Concordium Wallet seed phrase,
  or any private key — only public URLs and public responses.
