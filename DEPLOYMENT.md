# Deploying QuickGift to the Internet

This walks through the cheapest path to a real, publicly reachable
deployment: **Render** for the backend + PostgreSQL (has a free tier), and
**Netlify** (or Vercel/GitHub Pages) for the three static frontends. Swap in
your own provider if you prefer — the steps are the same shape everywhere
(a Node host + a Postgres host + a static host).

---

## 1. Push this project to GitHub
```bash
cd quickgift-platform
git init
git add .
git commit -m "QuickGift platform"
```
Create an empty repo on GitHub, then:
```bash
git remote add origin https://github.com/<you>/quickgift-platform.git
git push -u origin main
```

## 2. Database — Render Postgres (or Neon / Supabase, same idea)
1. On [render.com](https://render.com) → **New +** → **PostgreSQL** → free plan.
2. Once created, open it and copy the **External Database URL**.
3. Apply the schema from your own machine:
   ```bash
   psql "<the External Database URL>" -f database/schema.sql
   ```

## 3. Backend — Render Web Service
1. **New +** → **Web Service** → connect your GitHub repo → set **Root Directory** to `backend`.
2. Build command: `npm install` · Start command: `node server.js`.
3. Add environment variables (Render's dashboard → Environment tab) — use the
   values from `.env.example`, pointing `DB_HOST`/etc. at the Postgres
   instance from step 2 (Render Postgres gives you separate host/port/user/
   password/dbname fields, or you can parse them from the connection URL).
   **Set a real `JWT_SECRET`** (see the generation command in `.env.example`).
4. Deploy. Once live, note your backend URL, e.g. `https://quickgift-api.onrender.com`.
5. Seed demo data once, from your own machine, pointed at the live DB:
   ```bash
   cd backend
   DB_HOST=<render-host> DB_PORT=<port> DB_USER=<user> DB_PASSWORD=<pw> DB_NAME=<db> node seed.js
   ```
   (Or skip seeding entirely for a real launch — see "Replacing demo data" below.)

## 4. Frontends — Netlify (drag-and-drop, no build step)
Each frontend is a single static file, so this is literally drag-and-drop:
1. Before uploading, add your live API URL to the top of each `index.html`,
   right before the closing `</head>` tag or the first `<script>` tag:
   ```html
   <script>window.QUICKGIFT_API_BASE = "https://quickgift-api.onrender.com/api";</script>
   ```
2. Go to [app.netlify.com/drop](https://app.netlify.com/drop), drag the
   `frontend-customer` folder in. Repeat for `frontend-partner` and
   `frontend-admin` (three separate Netlify sites/URLs — matches the spec's
   "three connected applications").
3. Back on Render, set `CORS_ORIGIN` to your three Netlify URLs (comma-
   separated, or update `server.js` to accept an array) so the browser is
   allowed to call your API from those domains.

You now have three public URLs, e.g.:
- `https://quickgift.netlify.app` (customer)
- `https://quickgift-partner.netlify.app` (seller)
- `https://quickgift-admin.netlify.app` (admin)

## 5. Turn on real payments/SMS/email
Go back to Render's Environment tab and add the Razorpay/Twilio/Resend
variables from `.env.example` once you have those accounts — no code changes
or redeploy of logic needed, just env vars (a redeploy/restart picks them up).

## 6. Run the smoke test against your live server
```bash
BASE_URL=https://quickgift-api.onrender.com/api ./test-api.sh
```

---

## Replacing demo/seed data with real sellers and products
You don't need to touch the seed script for this — the platform already has
the real workflow built for it:
1. Skip `npm run seed`, or run it once just for the roles/countries/
   categories/currencies rows (comment out the products/orders sections in
   `seed.js` if you want an otherwise-empty catalog).
2. Real sellers sign up and apply through **QuickGift Partner** →
   `POST /api/sellers/register` — status starts `pending`.
3. You (as admin) approve them in **QuickGift Admin** → Sellers → Approve.
4. Approved sellers add their real products through the Partner app — each
   one starts `pending_approval`.
5. You approve each product in **QuickGift Admin** → Products before it
   becomes publicly visible — this is the same approval gate the seed data
   bypassed directly at the database level.

## Production checklist before handling real money
- [ ] `JWT_SECRET` is a real random value, not the placeholder
- [ ] `PAYMENT_PROVIDER=razorpay` with real keys, `RAZORPAY_WEBHOOK_SECRET` set and the webhook URL configured in the Razorpay dashboard to point at `https://your-api/api/payments/webhook`
- [ ] `CORS_ORIGIN` is your real frontend domain(s), not `*`
- [ ] Database backups are enabled on whichever Postgres host you use
- [ ] `test-api.sh` passes with `PAYMENT_PROVIDER=razorpay` set (tests the forged-webhook rejection)
- [ ] You've read and are comfortable with the "Honest limitations" section in `README.md`
