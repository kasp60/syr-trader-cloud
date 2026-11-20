# SYR TRADER

Cloudflare-first application for the SYR TRADER project.

## Stack
- Cloudflare Workers for the API runtime
- Cloudflare Worker static assets for the web interface
- Cloudflare D1 will be added for persistent data after schema and access rules are finalized
- GitHub `main` is the production source branch

## Local development
```sh
npm install
npm run dev
```

## Deploy
```sh
npm run deploy
```

## Health check
`GET /api/health`

## Safety status
Trading, deposits, withdrawals, and real-money functionality are intentionally disabled. Do not enable financial operations until authentication, authorization, audit logging, balance invariants, operational controls, and security tests are implemented and reviewed.

## Cloudflare setup
The Worker uses the `ASSETS` binding configured in `wrangler.toml`. D1 and R2 bindings are intentionally not declared until their resources and migrations are created in the Cloudflare account.
