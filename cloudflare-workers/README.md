# Cloudflare Workers — Project Kestrel API

Backend for feedback/bug reports, crash reports, and anonymous usage analytics.

## Setup

1. **Install wrangler**:
   ```bash
   npm install
   ```

2. **Create KV namespaces**:
   ```bash
   npx wrangler kv namespace create ANALYTICS
   npx wrangler kv namespace create RATE_LIMIT
   ```
   Copy the IDs into `wrangler.toml`.

3. **Set secrets**:
   ```bash
   npx wrangler secret put KESTREL_SHARED_SECRET
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put NOTIFY_EMAIL
   npx wrangler secret put ADMIN_KEY
   ```

4. **Configure route** (optional): Uncomment the `route` line in `wrangler.toml` and update for your domain.

5. **Local dev**:
   ```bash
   npm run dev
   ```

6. **Deploy**:
   ```bash
   npm run deploy
   ```

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/feedback` | `X-Kestrel-Key` | Bug reports, suggestions, feedback |
| `POST` | `/api/crash` | `X-Kestrel-Key` | Crash reports |
| `POST` | `/api/analytics` | `X-Kestrel-Key` | Store per-folder analytics |
| `GET` | `/api/analytics` | `X-Admin-Key` | Query analytics (admin) |
| `GET` | `/api/health` | None | Health check |
