# Angel Name Registry (AAGDB) — Railway

Simple form → REST API → PostgreSQL on [Railway](https://railway.app).  
Designed so an external automation script can poll for `pending` rows and trigger photo generation.

## Stack

- **Node.js + Express + TypeScript**
- **PostgreSQL** (Railway plugin)
- **Static HTML + Tailwind** (served by Express)
- Zod validation, rate limiting, Helmet, CORS, structured JSON logs

## Schema

| Column         | Type        | Notes                                      |
|----------------|-------------|--------------------------------------------|
| `id`           | UUID        | Primary key (`gen_random_uuid()`)          |
| `real_name`    | TEXT        | Required                                   |
| `angel_name`   | TEXT        | Required                                   |
| `email`        | TEXT        | Required on submit                         |
| `graphic_code` | TEXT        | Selected from `graphic_options.code`       |
| `status`       | TEXT        | `pending` \| `processing` \| `processed` \| `failed` |
| `created_at`   | TIMESTAMPTZ | Set on insert                              |
| `updated_at`   | TIMESTAMPTZ | Updated on status changes                  |
| `metadata`     | JSONB       | Extensible bag (photo URLs, errors, etc.)  |

Dropdown options live in `graphic_options` (`code`, `label`, `active`, `sort_order`). Add rows in Postgres as needed — nothing is auto-seeded on boot.

Indexes on `real_name`, `angel_name`, `status`, and a partial index for pending rows.

Migrations run automatically on app boot.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/graphics` | Active graphic dropdown options from DB |
| `POST` | `/submit` | `{ "real_name", "angel_name", "email", "graphic_code" }` → create entry (`status: pending`) |
| `POST` | `/newsletter/subscribe` | `{ "email" }` → mailing-list opt-in (popup / footer forms) |
| `POST` | `/contact` | `{ "name", "email", "message" }` → save message + forward to the ProtonMail inbox |
| `GET` | `/admin/contact-messages` | Contact inbox (admin session required) |
| `GET` | `/auth/facebook/config` | Whether Facebook quick sign-in is enabled (+ app id) |
| `POST` | `/auth/facebook` | `{ "access_token" }` → verify with Facebook, store email securely |
| `POST` | `/track/pageview` | Anonymous page-view beacon (no IPs / PII stored) |
| `GET` | `/admin/analytics?days=` | Dashboard metrics: traffic, returning users, top pages, devices |
| `GET` | `/shop/config` | Shop status, Stripe publishable key, price |
| `GET` | `/shop/graphics` | Archive graphics dropdown (every option ever offered) |
| `POST` | `/shop/checkout` | Start a $5 purchase → Stripe PaymentIntent client secret |
| `POST` | `/shop/confirm` | Verify a payment server-side with Stripe, mark purchase paid |
| `POST` | `/stripe/webhook` | Optional Stripe webhook (needs `STRIPE_WEBHOOK_SECRET`) |
| `GET` | `/admin/purchases` | Shop orders (admin session required) |

### The Archive Shop (`/shop`)

Past graphic styles are sold as **$5 AAG Archive Graphics**. The
`archive_graphics` table permanently tracks every option ever offered on the
request form (synced automatically on boot and whenever an admin adds an
option — removing an option from the form keeps it in the archive). The shop
page walks buyers through a large-type, step-by-step guided checkout
(graphic → names → email → review & pay) with an embedded Stripe Payment
Element. Amounts are always set server-side; payments are verified with
Stripe server-side before an order is marked paid. Orders appear in the
admin portal's **Orders** tab. Configure with `STRIPE_SECRET_KEY` +
`STRIPE_PUBLISHABLE_KEY` (and optionally `STRIPE_WEBHOOK_SECRET` +
`SHOP_PRICE_CENTS`).

### Analytics dashboard

The admin portal opens on a **Dashboard** tab with traffic charts and metrics
(7 / 30 / 90-day ranges): page views, unique visitors, new vs returning,
devices, top pages, top referrers, plus request/newsletter/contact counts.
Tracking is privacy-friendly by design: the browser keeps a **random id**
(no personal data) in localStorage so returning visitors can be counted, and
the server stores only a **salted hash** of that id along with path, referrer
hostname, and a coarse device bucket. No IP addresses, no fingerprinting, no
third-party trackers. Optionally set `ANALYTICS_SALT` to a random string to
strengthen the hashing.

### Facebook quick sign-in

Set `FB_APP_ID` and `FB_APP_SECRET` to enable it. When a visitor lands on the
site with an active Facebook session in their browser, they get a one-tap
"Continue with Facebook" prompt that requests their **email** permission. The
popup tells them plainly: the email is stored securely in our database and
used for business purposes only. Tokens are verified server-side with the
Graph API (`debug_token`) before anything is saved to `facebook_users`.
Without the env vars the feature is fully disabled — no SDK is loaded.

### Contact → ProtonMail

Contact-page messages are always stored in `contact_messages`. When SMTP is
configured (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, optional `SMTP_PORT` /
`SMTP_FROM`), each message is also emailed to `CONTACT_EMAIL_TO`
(default **aaggraphics@protonmail.com**) with the sender set as reply-to.
ProtonMail doesn't accept direct SMTP logins on free plans — point the SMTP
vars at Proton Mail Bridge, a Proton SMTP token (paid plans), or any
transactional relay (Resend, Mailgun, SendGrid, …).
| `GET` | `/entries` | List entries (`?limit=&offset=`) |
| `GET` | `/pending` | Unprocessed entries (oldest first) — **for automation** |
| `GET` | `/entry/:id` | Fetch by UUID |
| `GET` | `/lookup?angel_name=` or `?real_name=` | Lookup latest match |
| `PATCH` | `/entry/:id/status` | `{ "status", "metadata?" }` — mark processed/failed |
| `GET` | `/health` | Liveness |

### Example: submit

```bash
curl -X POST https://YOUR_APP.up.railway.app/submit \
  -H 'Content-Type: application/json' \
  -d '{"real_name":"Alex Rivera","angel_name":"Seraphine","email":"alex@example.com","graphic_code":"graphic1"}'
```

### Example: poll pending (automation)

```bash
curl https://YOUR_APP.up.railway.app/pending?limit=20
```

### Example: mark processed

```bash
curl -X PATCH https://YOUR_APP.up.railway.app/entry/ENTRY_UUID/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"processed","metadata":{"photo_url":"https://..."}}'
```

A ready-made poller lives at [`scripts/poll_pending.py`](scripts/poll_pending.py).

---

## Run locally

### 1. Prerequisites

- Node.js 20+
- PostgreSQL running locally (or a Railway Postgres `DATABASE_URL`)

### 2. Install & configure

```bash
cp .env.example .env
# Edit DATABASE_URL in .env
npm install
```

### 3. Start

```bash
npm run dev
# → http://localhost:3000
```

Schema is created/updated on startup. You can also run:

```bash
npm run db:migrate
```

---

## Deploy on Railway

### Step-by-step

1. **Create a Railway project**  
   - Go to [railway.app](https://railway.app) → New Project.

2. **Add PostgreSQL**  
   - In the project: **New** → **Database** → **PostgreSQL**.  
   - Railway injects `DATABASE_URL` (and related vars) for services that reference it.

3. **Add the web service**  
   - **New** → **GitHub Repo** (point at this repository), **or** deploy from local with the Railway CLI:
     ```bash
     npm i -g @railway/cli
     railway login
     railway init
     railway up
     ```

4. **Link the database to the web service**  
   - Open the web service → **Variables**.  
   - Add a reference variable so the web service gets the private URL, e.g.:
     - Variable: `DATABASE_URL`
     - Value: `${{Postgres.DATABASE_URL}}`  
       (or `${{Postgres.DATABASE_PRIVATE_URL}}` for private networking — preferred).

5. **Public networking**  
   - Web service → **Settings** → **Networking** → **Generate Domain**.  
   - Keep Postgres **private** (default). Only the web service should talk to the DB over Railway’s private network.

6. **Build / start**  
   - Covered by [`railway.json`](railway.json):
     - Build: `npm install && npm run build`
     - Start: `npm start`
     - Health check: `/health`

Optional: use the included [`Dockerfile`](Dockerfile) by setting the service builder to Dockerfile in Railway settings.

### Connection string notes

| Context | What to use |
|---------|-------------|
| Local app | `postgresql://user:pass@localhost:5432/aagdb` in `.env` |
| Railway web → Postgres | Private URL via `${{Postgres.DATABASE_PRIVATE_URL}}` or `DATABASE_URL` |
| External automation via API | Call your public HTTPS domain — **do not** expose Postgres publicly |
| External direct DB access | Only if you enable Railway’s public Postgres proxy and use `DATABASE_PUBLIC_URL` (not recommended for production) |

---

## How automation should watch the DB

Prefer the HTTP API over opening Postgres from the worker:

1. Poll `GET /pending` every N seconds.
2. For each entry, set `status` to `processing`.
3. Generate the photo.
4. `PATCH /entry/:id/status` with `processed` (and store `photo_url` in `metadata`).
5. On failure, set `status` to `failed` with an error in `metadata`.

SQL alternative (if the worker has private network access to Postgres):

```sql
SELECT * FROM entries
WHERE status = 'pending'
ORDER BY created_at ASC
LIMIT 50;
```

---

## Project layout

```
├── public/
│   ├── index.html         # Home (hero, counter, mailing list)
│   ├── about.html         # About us
│   ├── contact.html       # Contact form
│   ├── form.html          # Request form
│   ├── admin/             # Admin login + portal
│   └── assets/            # Shared design system (site.css, site.js + opt-in popup)
├── src/
│   ├── index.ts           # Express app
│   ├── routes.ts          # REST endpoints
│   ├── validation.ts      # Zod schemas
│   ├── logger.ts
│   └── db/
│       ├── pool.ts
│       ├── migrate.ts
│       ├── entries.ts
│       ├── contact.ts
│       └── stats.ts
├── scripts/poll_pending.py
├── railway.json
├── Procfile
├── Dockerfile
├── .env.example
└── package.json
```

## License

MIT
