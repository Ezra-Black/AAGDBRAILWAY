# Angel Name Registry (AAGDB) — Railway

Simple form → REST API → PostgreSQL on [Railway](https://railway.app).  
Designed so an external automation script can poll for `pending` rows and trigger photo generation.

## Stack

- **Node.js + Express + TypeScript**
- **PostgreSQL** (Railway plugin)
- **Static HTML + Tailwind** (served by Express)
- Zod validation, rate limiting, Helmet, CORS, structured JSON logs

## Schema

| Column       | Type        | Notes                                      |
|--------------|-------------|--------------------------------------------|
| `id`         | UUID        | Primary key (`gen_random_uuid()`)          |
| `real_name`  | TEXT        | Required                                   |
| `angel_name` | TEXT        | Required                                   |
| `status`     | TEXT        | `pending` \| `processing` \| `processed` \| `failed` |
| `created_at` | TIMESTAMPTZ | Set on insert                              |
| `updated_at` | TIMESTAMPTZ | Updated on status changes                  |
| `metadata`   | JSONB       | Extensible bag (photo URLs, errors, etc.)  |

Indexes on `real_name`, `angel_name`, `status`, and a partial index for pending rows.

Migrations run automatically on app boot.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/submit` | `{ "real_name", "angel_name" }` → create entry (`status: pending`) |
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
  -d '{"real_name":"Alex Rivera","angel_name":"Seraphine"}'
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
├── public/index.html      # Form (Tailwind CDN)
├── src/
│   ├── index.ts           # Express app
│   ├── routes.ts          # REST endpoints
│   ├── validation.ts      # Zod schemas
│   ├── logger.ts
│   └── db/
│       ├── pool.ts
│       ├── migrate.ts
│       └── entries.ts
├── scripts/poll_pending.py
├── railway.json
├── Procfile
├── Dockerfile
├── .env.example
└── package.json
```

## License

MIT
