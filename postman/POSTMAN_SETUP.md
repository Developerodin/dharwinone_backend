# Dharwin Communication APIs — Postman setup

## Files (import both)

| File | Purpose |
|------|---------|
| `postman/Dharwin-Local.postman_environment.json` | Variables: baseUrl, email, password, accessToken |
| `postman/Dharwin-Communication-APIs.postman_collection.json` | Collection with Login + Communication endpoints |
| `postman/Dharwin-Communication-APIs-EC2.postman_collection.json` | Standalone EC2/prod collection with `baseUrl=https://apis.dharwinone.com/v1` |

Full paths:

```
C:\Users\INTEL\Desktop\DHARWIN NEW\uat.dharwin.backend\postman\Dharwin-Local.postman_environment.json
C:\Users\INTEL\Desktop\DHARWIN NEW\uat.dharwin.backend\postman\Dharwin-Communication-APIs.postman_collection.json
C:\Users\INTEL\Desktop\DHARWIN NEW\uat.dharwin.backend\postman\Dharwin-Communication-APIs-EC2.postman_collection.json
```

## Prerequisites

1. Backend running: `npm run dev` in `uat.dharwin.backend` (default port **3000**).
2. Valid user credentials with permissions (e.g. `calls.read` for GET All Calls).

## Steps in Postman

1. **Import** → drag both JSON files (or File → Import).
2. Top-right **Environments** → select **Dharwin Local** (must be selected, not "No environment").
3. Open **Dharwin Local** → set:
   - `email` = your login email
   - `password` = your password
   - `baseUrl` = `http://localhost:3000/v1` (local) or `https://apis.dharwinone.com/v1` (prod/EC2)
4. Run **Auth Bootstrap → Login** → expect **200**; Tests tab saves `accessToken`.
5. Run **Communication - Unified Calls → GET All Calls** → expect **200** with JSON body.
6. Optional Gmail flow: run **Email - Gmail → GET Gmail Accounts** first; it saves the first `accountId` for **GET Gmail Messages**.

For EC2/prod, import `Dharwin-Communication-APIs-EC2.postman_collection.json`, open collection variables, and set `email`/`password`. Its `baseUrl` is already `https://apis.dharwinone.com/v1` with no trailing slash.

## Collection auth (already configured)

- Collection-level: **Bearer Token** = `{{accessToken}}`
- Login request uses **No Auth** (overrides collection)

## Login Tests script (already in collection)

```javascript
pm.test('Login succeeded', function () {
  pm.response.to.have.status(200);
});

const json = pm.response.json();
if (json.tokens && json.tokens.access && json.tokens.access.token) {
  pm.environment.set('accessToken', json.tokens.access.token);
} else {
  console.warn('No tokens in JSON. Set AUTH_RETURN_TOKENS_IN_JSON=true in backend .env.');
}
```

## GET All Calls — correct query params

Do **not** use `sortBy=createdAt:desc`. Use two params:

| Param | Value |
|-------|--------|
| sortBy | `createdAt` or `date` |
| order | `asc` or `desc` |

Optional: `page`, `limit`, `source` (`all` \| `telephony` \| `in_app`), `search`, `status`, `purpose`, `language`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Please authenticate | Run Login first; check environment is **Dharwin Local** selected |
| `{{baseUrl}}` not resolved | Select environment; set `baseUrl` with `/v1` suffix |
| Login 200 but no token saved | Add `AUTH_RETURN_TOKENS_IN_JSON=true` to backend `.env` (dev usually OK without) |
| 403 Forbidden | User lacks permission (e.g. `calls.read`) |
| Connection refused | Start backend: `npm run dev` |

## EC2 / mobile app

Postman and the mobile app both call the same HTTP API. Set `baseUrl` to your server URL + `/v1`. No special Postman↔EC2 integration.

Mobile env: `EXPO_PUBLIC_API_URL` should match the same host (with `/v1` if your app expects it).

## Verify with curl (optional)

```bash
# 401 without token
curl.exe http://localhost:3000/v1/communication/calls

# After login, replace TOKEN
curl.exe -H "Authorization: Bearer TOKEN" "http://localhost:3000/v1/communication/calls?page=1&limit=10&sortBy=createdAt&order=desc"
```
