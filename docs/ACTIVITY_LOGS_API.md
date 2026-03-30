# Activity Logs & Audit Trails

Important actions by administrators and significant user actions are recorded for audit and compliance. Logs include actor identity, action, affected entity, timestamp, optional HTTP context, and approximate location when available. They are retained per your operational / DB policy and metadata is sanitized so passwords, tokens, and common PII keys are not stored.

---

## Access control

- **API — list:** `requireActivityLogsListAccess`: designated platform email, **`platformSuperUser`**, users with **`activityLogs.read`** / **`activity.read`** (via roles), or **`actor` query equal to own user id** (candidate “my activity”). Full query filters apply for privileged callers; self-actor callers get **`{ actor: self }`** only (see `activityLog.controller.js`).
- **API — export:** `GET /v1/activity-logs/export` requires a **designated** email (`requireDesignatedSuperadmin` only).
- **Designated emails:** Comma-separated in **`DESIGNATED_SUPERADMIN_EMAILS`**; when unset or empty, defaults to **`harvinder@superadmin.in`**.
- **Frontend:** Standard logs UI at **`/logs/logs-activity`** uses **`logs.activity:`** permission (and admin / platform super in **PermissionGuard**). Advanced console at **`/logs/logs-activity/platform`** is **designated-only** (`isDesignatedSuperadmin`).

---

## Requirements (implemented)

- **Administrator / ATS actions:** Roles, users, impersonation, categories, students, mentors, training, attendance, certificates, **candidates**, **jobs**, **job applications** (create/update/delete as applicable).
- **Log fields:** `actor`, `action`, `entityType`, `entityId`, `metadata`, `ip`, `userAgent`, **`httpMethod`**, **`httpPath`**, **`geo`** (e.g. `country` from `CF-IPCountry` when behind Cloudflare), optional **`clientGeo`** (browser GPS when a privileged user opts in; see below), `createdAt`.
- **Write safety:** If persisting a log fails (DB error, etc.), the failure is logged server-side and **does not** fail the primary HTTP operation (e.g. user update still succeeds).
- **Retention:** Stored in the `ActivityLog` collection; TTL/archival are operational decisions.
- **Metadata:** Sanitized (no passwords, tokens, email, phone, SSN-style keys, etc.). Actor in list responses: **`id` and `name` only**.

### Deployment: correct client IP (location + rate limits)

- Set **`TRUST_PROXY_HOPS`** in `.env` when the API sits behind a **trusted** reverse proxy, load balancer, or Cloudflare (typically **`1`** for one hop). Configured in [`src/app.js`](../src/app.js) as Express **`trust proxy`**. If unset/`0`, `req.ip` is the direct TCP peer (often `127.0.0.1` in dev or the LB internal IP in prod), so activity **IP**/**Location** and **per-IP rate limits** can be wrong.
- Optional **`TRUST_PROXY=true`** (when hops are `0`): enables `app.set('trust proxy', true)`. Prefer an explicit hop count when you know it.
- Your edge must **set or overwrite** `X-Forwarded-For` (do not trust client-forged values from the open internet). Example nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. See [Express behind proxies](https://expressjs.com/en/guide/behind-proxies.html).
- **Audit `ip` is never taken from browser headers** (e.g. ipify-injected values). Each log row stores the **TCP/proxy-derived client** for that HTTP request only, so list/export APIs return the stored field as-is (aside from normal `geo` display enrichment from that stored IP).

### Optional: browser location (signed-in users)

- Clients may send header **`X-Activity-Client-Geo`** on API requests. The timestamp must be **within 30 minutes** (`ts`); values are validated server-side.
- **Preferred format (JSON):** `{"ts":<epochMs>,"accuracy":<meters>,"city":"...","region":"...","country":"..."}` — at least one of `city` / `region` / `country` **or** valid **`lat`** + **`lng`** (or **`lon`**) when the client could not reverse-geocode; the server then calls Nominatim once. **Precise coordinates are not persisted** on new writes; only coarse place fields and `accuracyM`, `capturedAt`, `source: browser_geolocation` are stored.
- **Legacy format (CSV):** `lat,lng,accuracyM,epochMs` — the server **reverse-geocodes once** (Nominatim) and stores **place names only** (same shape as JSON path; coordinates are not saved).
- Stored **`clientGeo`** complements server-derived **`ip`** and IP-based **`geo`**. The frontend captures geolocation **before** `POST /auth/login` when allowed (reverse geocode via OpenStreetMap Nominatim in the browser, with session cache), and may refresh after sign-in.
- CORS must allow **`X-Activity-Client-Geo`** on the frontend origin (see [`src/app.js`](../src/app.js) `allowedHeaders`).
- **GET /v1/activity-logs/network-preview** — same auth as list (`requireActivityLogsListAccess`); returns **`{ "ip": "<server-seen address>" }`** (optional; for custom tooling).

---

## Endpoint: List activity logs

**GET /v1/activity-logs**

- **Auth:** See Access control (designated / platform super / activity read / self-actor).

### Query (optional)

| Param | Type | Description |
| ----- | ---- | ----------- |
| actor | string | Actor user id (MongoDB ObjectId) |
| action | string | Filter by action (e.g. `role.create`, `candidate.update`) |
| entityType | string | e.g. `Role`, `User`, `Candidate`, `Job`, `JobApplication` |
| entityId | string | Affected entity id |
| startDate | string | ISO start of range |
| endDate | string | ISO end of range |
| **includeAttendance** | boolean or `"true"` / `"false"` | When **not** true, **`attendance.*`** actions are **excluded** by default (reduces noise). Ignored if `action` is already an `attendance.*` filter. |
| sortBy | string | Comma-separated, each segment `field:order` with field one of `createdAt`, `action`, `entityType` and order `asc` or `desc`. Example: `createdAt:desc` |
| limit | number | Page size, **1–100** (default 10 in service if omitted) |
| page | number | Page number, **≥ 1** |

### Response: `200 OK`

```json
{
  "results": [
    {
      "id": "...",
      "actor": { "id": "...", "name": "Admin" },
      "action": "role.create",
      "entityType": "Role",
      "entityId": "...",
      "metadata": {},
      "ip": "::1",
      "userAgent": "...",
      "httpMethod": "POST",
      "httpPath": "/v1/roles",
      "geo": { "country": "US", "region": null, "city": null },
      "createdAt": "2025-02-04T..."
    }
  ],
  "page": 1,
  "limit": 10,
  "totalPages": 1,
  "totalResults": 5
}
```

Older documents may have **`httpMethod`**, **`httpPath`**, **`geo`**, or **`clientGeo`** omitted (null/empty).

**List response `clientGeo` (optional):** When present, shape includes `{ "city", "region", "country", "accuracyM", "capturedAt", "source": "browser_geolocation" }` (place-first). Older documents may still include **`lat`** / **`lng`** from prior versions.

**List response `displayLocation` (optional):** Convenience string: GPS place + ` (GPS)` when `clientGeo` has a place; otherwise IP-derived `geo` + ` (IP approx)` when available; otherwise omitted/null.

**List response `geo` (enriched):** For each row, if stored `geo` has no country/region/city, the API fills display location from the stored **`ip`**: **local/private** addresses (e.g. `127.0.0.1`, RFC1918) map to a **`city` label** (`Local / private network`); **public IPv4** uses the bundled **GeoLite-derived** database from `geoip-lite` (approximate; update the package / data periodically). Rows that already have `geo` from Cloudflare are unchanged.

---

## Endpoint: Network preview (server-seen IP)

**GET /v1/activity-logs/network-preview**

- **Auth:** Same as list (`requireActivityLogsListAccess`).
- **Response:** `200` — `{ "ip": "<string or null>" }` — Express **`req.ip`** after **`trust proxy`** (same value persisted on new log rows as **`ip`**). For UI only; not a substitute for list/export.

---

## Actions recorded (non-exhaustive)

| Action | entityType | When |
| ------ | ---------- | ---- |
| `role.*` | Role | Role lifecycle |
| `user.*` | User | User lifecycle / disable |
| `impersonation.*` | Impersonation | Impersonation start/end |
| `category.*` | Category | Category CRUD |
| `student.*` / `mentor.*` | Student / Mentor | Profile updates |
| `student.course.*` / `student.quiz.*` / `certificate.*` | … | Training / quiz / certificate |
| `attendance.*` | Attendance | Punch / auto punch (hidden from default list unless `includeAttendance=true`) |
| **`candidate.*`** | **Candidate** | **Create / update / delete** (incl. self-service profile update) |
| **`job.*`** | **Job** | **Create / update / delete** |
| **`jobApplication.*`** | **JobApplication** | **Create / status update / delete / withdraw** |
| **`settings.bolnaCandidateAgent.update`** | **BolnaCandidateAgentSettings** | **Bolna candidate voice-agent instructions / greeting updated** |

---

## Security and PII

- Do not put secrets or unnecessary PII in `metadata`; the service strips known sensitive key substrings.
- **Geo** from **`CF-IPCountry`** is only trustworthy when the header is set by your **CDN / edge**, not by the browser.
- **`X-Activity-Client-Geo`** is **user-supplied** (browser); it is **validated** (freshness, coarse place fields or legacy CSV + server reverse geocode) and persisted when valid. New writes store **city/region/country**, not precise coordinates. It supplements, not replaces, server **`ip`** / **`geo`**. Do not send client-reported public IP headers for audit — they are **ignored** server-side.
- Apply normal **rate limiting** for admin list endpoints in production.

---

## Example

```http
GET /v1/activity-logs?actor=6982db99323fa3193546ac6f&startDate=2025-02-01T00:00:00.000Z&endDate=2025-02-05T23:59:59.999Z&limit=20&includeAttendance=false
Authorization: Bearer <access token>
```
