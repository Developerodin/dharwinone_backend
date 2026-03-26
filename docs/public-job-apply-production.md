# Public job apply — production checklist

Use this when debugging **“Network Error”** or failed uploads on **POST `/v1/public/jobs/:jobId/apply`** (public apply from `public-job/[jobId]`).

## Frontend (`NEXT_PUBLIC_API_URL`)

- **Same-origin (recommended):** Leave `NEXT_PUBLIC_API_URL` unset (or empty) in the browser build so the app uses **`/api/v1`**. Next rewrites that to the backend ([`next.config.js`](../../uat.dharwin.frontend/next.config.js) in the frontend app). CORS is not involved for API calls to `/api/v1` from the site origin.
- **Cross-origin:** If the build sets `NEXT_PUBLIC_API_URL` to a full API base (e.g. `https://api.example.com/v1`):
  - The browser sends credentialed requests; the backend must return `Access-Control-Allow-Origin` as the **exact** page origin (not `*`), with `Access-Control-Allow-Credentials: true`.
  - List **every** origin users use: apex and `www`, staging domains, etc.

## Backend (`CORS_ORIGIN`)

- In production, `CORS_ORIGIN` in [`src/config/config.js`](../src/config/config.js) is a comma-separated allowlist. Each value must **exactly** match the `Origin` header (scheme + host + port).
- Example: include both `https://dharwinone.com` and `https://www.dharwinone.com` if both serve the app.
- [`src/app.js`](../src/app.js) uses `credentials: true` for CORS.

## Reverse proxy / CDN (body size and timeouts)

The apply form allows a **resume** plus up to **five** attachments, **10MB per file**. Nginx’s default **`client_max_body_size` is 1m**, which is too small and can cause **413** or connection resets; clients may report that as a generic network failure.

**Verify on every hop** in front of Node (CDN, edge nginx, load balancer, platform router):

- **`client_max_body_size`** (or equivalent) — set high enough for worst case (e.g. **50M** or higher if you allow 6×10MB).
- **Read/send/proxy timeouts** — mobile uploads are slow; allow several minutes on upload locations if needed.
- After changes, reload proxies and retest a large file from a throttled mobile connection.

## Optional server logging

To see whether failures are **before** the app (proxy) vs **in** the app (multer/validation), add short-lived logging at the start of the public apply handler: `jobId`, `Origin`, and `Content-Length` (if present).
