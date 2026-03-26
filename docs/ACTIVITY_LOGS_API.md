# Activity Logs & Audit Trails

Important actions by administrators and significant user actions are recorded for audit and compliance. Logs include actor identity, action, affected entity, timestamp, optional HTTP context, and approximate location when available. They are retained per your operational / DB policy and metadata is sanitized so passwords, tokens, and common PII keys are not stored.

---

## Access control

- **API permission:** `GET /v1/activity-logs` requires **`activityLogs.read`** *or* derived **`activity.read`** (e.g. from domain permission `logs.activity:view` on roles — see `src/config/permissions.js` and `permission.service.js`).
- **Frontend:** Users with **`logs.activity:view`**, raw `activity.read` / `activityLogs.read`, the **Administrator** role (by name), or **platform super user** can open the Activity Logs UI. Enforcement on the API remains authoritative.

---

## Requirements (implemented)

- **Administrator / ATS actions:** Roles, users, impersonation, categories, students, mentors, training, attendance, certificates, **candidates**, **jobs**, **job applications** (create/update/delete as applicable).
- **Log fields:** `actor`, `action`, `entityType`, `entityId`, `metadata`, `ip`, `userAgent`, **`httpMethod`**, **`httpPath`**, **`geo`** (e.g. `country` from `CF-IPCountry` when behind Cloudflare), `createdAt`.
- **Write safety:** If persisting a log fails (DB error, etc.), the failure is logged server-side and **does not** fail the primary HTTP operation (e.g. user update still succeeds).
- **Retention:** Stored in the `ActivityLog` collection; TTL/archival are operational decisions.
- **Metadata:** Sanitized (no passwords, tokens, email, phone, SSN-style keys, etc.). Actor in list responses: **`id` and `name` only**.

### Deployment: correct client IP (location + rate limits)

- Set **`TRUST_PROXY_HOPS`** in `.env` when the API sits behind a **trusted** reverse proxy, load balancer, or Cloudflare (typically **`1`** for one hop). Configured in [`src/app.js`](../src/app.js) as Express **`trust proxy`**. If unset/`0`, `req.ip` is the direct TCP peer (often `127.0.0.1` in dev or the LB internal IP in prod), so activity **IP**/**Location** and **per-IP rate limits** can be wrong.
- Your edge must **set or overwrite** `X-Forwarded-For` (do not trust client-forged values from the open internet). See [Express behind proxies](https://expressjs.com/en/guide/behind-proxies.html).

---

## Endpoint: List activity logs

**GET /v1/activity-logs**

- **Auth:** Required. Caller must satisfy **`activityLogs.read`** / **`activity.read`** (or platform super user), as enforced by `requirePermissions('activityLogs.read')`.

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

Older documents may have **`httpMethod`**, **`httpPath`**, or **`geo`** omitted (null/empty).

**List response `geo` (enriched):** For each row, if stored `geo` has no country/region/city, the API fills display location from the stored **`ip`**: **local/private** addresses (e.g. `127.0.0.1`, RFC1918) map to a **`city` label** (`Local / private network`); **public IPv4** uses the bundled **GeoLite-derived** database from `geoip-lite` (approximate; update the package / data periodically). Rows that already have `geo` from Cloudflare are unchanged.

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
- Apply normal **rate limiting** for admin list endpoints in production.

---

## Example

```http
GET /v1/activity-logs?actor=6982db99323fa3193546ac6f&startDate=2025-02-01T00:00:00.000Z&endDate=2025-02-05T23:59:59.999Z&limit=20&includeAttendance=false
Authorization: Bearer <access token>
```
