# SYR TRADER

SYR TRADER is a Cloudflare Workers application with a static web interface and a Cloudflare D1 database.

## Runtime

- Cloudflare Worker API: `src/index.js`
- Static interface: `public/`
- D1 binding: `DB`, database `syr-trader-db`
- Static assets binding: `ASSETS`
- Scheduled market worker: every minute (`* * * * *`)
- Production source branch: `main`

## Current application capabilities

- User registration, login, logout, and session management.
- USD and SYP internal wallets with a transaction ledger.
- USD/SYP currency exchange using the administrator-configured rate.
- Internal member-to-member transfers in SYP.
- Deposit requests with image proof; administrators review and credit approved requests manually.
- Withdrawal requests; funds are reserved while pending, and rejected requests are refunded.
- Simulated USD/SYP trading with long/short positions, leverage, margin reservation, settlement, and liquidation.
- An administrator-controlled internal market price and scheduled market movement.

## Important operating boundaries

- Market prices and trading activity are simulated by the platform; they are not connected to an external exchange or live market feed.
- Binance deposits are reviewed manually. There is no Binance API integration or automatic blockchain/payment verification.
- Withdrawal transfers are carried out manually by the administrator outside the application.
- Wallet balances are internal application records. Do not represent them as externally held or insured funds.
- Do not enable or advertise real-money trading or automated payment processing without a separate legal, security, accounting, and operational review.

## Security controls currently present in code

- PBKDF2-SHA-256 password hashing.
- Secure, HttpOnly, SameSite=Strict session cookies.
- Same-origin checks on state-changing browser requests.
- Login attempt throttling and IP-based registration throttling.
- Parameterized D1 queries and conditional wallet updates.
- Security response headers and server-side role checks.

These controls are not a substitute for an independent security audit. In particular, the project still needs dedicated automated tests for concurrent financial requests, wallet/ledger reconciliation, trade PnL and liquidation, deposit/withdrawal review races, and production D1 behavior.

## Local development

```sh
npm install
npm run dev
```

## Checks

```sh
npm run check
```

GitHub Actions runs a Worker syntax check on pushes to `main` and pull requests. This is a syntax check only; it does not test D1 queries, financial invariants, browser behavior, or Cloudflare production deployment.

## Deployment

Cloudflare is configured to deploy from the GitHub `main` branch. Confirm the latest deployment in the Cloudflare dashboard before treating a commit as live.

## Health check

`GET /api/health`
