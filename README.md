# QuickGift — Global Gifting Platform

A real full-stack marketplace: one PostgreSQL database, one Express API, and
three frontends — **Customer**, **Partner (seller)**, and **Admin**.

```
customer app ─┐
partner app  ─┼──► backend API (Express) ──► PostgreSQL
admin app    ─┘         │
                         ├── payments: Razorpay (real, via plain HTTPS — needs your keys) or mock
                         ├── exchange rates: live free API by default (no key needed)
                         └── notifications: in-app always real; email (Resend) + SMS (Twilio) real once you add keys
```

## What's real right now

| Feature | Status |
|---|---|
| Auth, roles, catalog, cart, checkout, order lifecycle, seller approval, admin analytics | **Fully real** — real SQL, real business rules, no mocked logic |
| Exchange rates | **Live by default** — calls a free public API, no signup needed |
| Payments | Real Razorpay integration is written and ready (`src/services/paymentProvider.js`) — set 3 env vars to activate. Defaults to a mock provider so you can build/test without any account |
| Email | Real integration via Resend's HTTP API — add `RESEND_API_KEY` to activate. Logs to console until then |
| SMS / OTP | Real integration via Twilio's HTTP API, with a real server-side OTP table (not a hardcoded code) — add Twilio credentials to activate. Logs the code to console/response until then |
| Courier tracking | Interface is ready (`src/services/courierTracking.js`); wiring a specific courier's API is the one piece left for you, since it depends which courier you contract with |

None of the above need extra npm packages — everything uses Node's built-in
`fetch`, so activating a real provider is purely an environment-variable
change, no code changes, no reinstall.

## Setup (local)

### 1. Database
```bash
createdb quickgift
psql -U postgres -d quickgift -f database/schema.sql
```
Or with Docker: `docker compose up postgres` (schema auto-applies on first boot).

### 2. Backend
```bash
cd backend
npm install
cp ../.env.example .env
# Generate a real secret and paste it into .env as JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm run seed     # roles, 5 countries, 22 categories, 10 sellers, 50 products, 10 customers, 20 orders
npm run dev      # http://localhost:4000 — visit http://localhost:4000/api/health to confirm it's up
```

### 3. Frontends
Each is a single static HTML file, no build step. Open directly in a browser,
or serve with `npx serve frontend-customer` (and same for partner/admin).

If your API is not at `http://localhost:4000/api`, add this line **above**
the existing `<script>` tag in each `index.html`:
```html
<script>window.QUICKGIFT_API_BASE = "https://your-api-domain.com/api";</script>
```

### 4. Verify it's actually working
```bash
./test-api.sh
```
This hits your running server and checks the security-critical rules: role
enforcement, price-tampering protection, review restrictions, seller-product
approval gating, and (once you're on `PAYMENT_PROVIDER=razorpay`) webhook
signature verification.

### Demo logins (created by `npm run seed`)
| Role | Email | Password |
|---|---|---|
| Admin | admin@quickgift.com | Admin@123 |
| Customer | customer1@example.com … customer10@example.com | Customer@123 |
| Seller | seller1@example.com … seller10@example.com | Seller@123 |

## Going to production
See **DEPLOYMENT.md** for exact steps (Render + Netlify, free tier) to get
this on the internet, plus how to replace demo/seed data with real sellers
and products through the Admin/Partner apps you already have.

## Project layout
```
database/schema.sql        Full Postgres DDL — every table from the spec (incl. otp_codes)
backend/
  server.js                Express app entry point
  seed.js                  Realistic demo data generator
  src/config/db.js         Connection pool
  src/middleware/          JWT auth, role checks, error handling
  src/routes/              One file per domain (auth, products, orders, sellers, admin, ...)
  src/services/            Payment (Razorpay/mock), exchange-rate (live), notification (Resend/Twilio), courier
frontend-customer/         Browse, cart, checkout (incl. Razorpay Checkout.js), orders, wishlist
frontend-partner/          Seller dashboard, products, orders, payouts
frontend-admin/            Analytics, users, sellers, product approval, coupons, countries
API_DOCUMENTATION.md       Full endpoint reference
DEPLOYMENT.md              Free-tier hosting steps + real-seller-data checklist
test-api.sh                Security/flow smoke test you run against your live server
.env.example               Every environment variable, explained
docker-compose.yml          Postgres + backend for one-command local infra
```

## Security built in (verify with `test-api.sh`)
- Passwords hashed with bcrypt (12 rounds)
- Every role check happens server-side (`requireRole` middleware) — the frontend cannot grant itself admin/seller access
- **Prices, discounts, tax and totals are calculated entirely server-side** at checkout — the frontend cannot set its own price (client-supplied price fields are ignored, not just unused)
- Stock is checked and decremented server-side before an order is created
- A payment is only ever marked "captured" by a signature-verified webhook, never by the frontend reporting success
- OTP codes are hashed, stored server-side with a 5-minute expiry, and single-use — not a hardcoded value
- Countries/currencies are database rows, not hardcoded strings
- `helmet`, a CORS allow-list, and rate limiting (especially on `/auth`) are on by default

## Honest limitations of this build
- Razorpay/Twilio/Resend need **your own accounts and credentials** — I can't create those for you, but the code that uses them is real and tested for syntax, not just described.
- Shipping cost calculation is stubbed at ₹0 — the `shipping_methods`/`couriers` tables exist and are ready, but rate calculation by weight/zone isn't implemented.
- Courier tracking updates (`tracking_events`) are only ever inserted by your own code today (seller marks packed, etc.) — pulling live GPS/status updates from a real courier's API is the one integration left unwritten, since it's courier-specific.
- Multi-language (`preferred_language` field exists) and AI features (spec sections 45/46) are prepared for but not implemented.
- These frontends are deliberately plain (no build tooling) so they run anywhere with zero setup; a production launch would likely rebuild them in React/Next.js against the same, unchanged API.
