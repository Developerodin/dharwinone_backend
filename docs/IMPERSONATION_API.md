# Administrator Impersonation (Login as User)

Administrators with the **Administrator** role (by `roleIds`) can temporarily access the system as another user for support or troubleshooting. Impersonation never grants more access than the impersonated user normally has. All sessions are auditable.

---

## Requirements (implemented)

- **Administrators** can start impersonation only if they have a Role with name **"Administrator"** in their `roleIds`.
- **Access**: While impersonating, the effective user is the impersonated user; permissions are based on that user only (no elevated access).
- **Audit**: Each impersonation is recorded with:
  - **Who** initiated: `adminUser`
  - **Which user** was accessed: `impersonatedUser`
  - **When** started: `startedAt`
  - **When** ended: `endedAt` (set when admin stops impersonation)
- **Exit**: Admin can call **POST /v1/auth/stop-impersonation** to end impersonation and return to their own account.
- **Auditability**: The `Impersonation` collection holds full history; access tokens carry `impersonation` payload for the session.

---

## Endpoints

### 1. Start impersonation

**POST /v1/auth/impersonate**

- **Auth:** Required (Bearer or cookie). Caller must have **Administrator** role (by `roleIds`).
- **Body:** `{ "userId": "<target user id>" }`
- **Response:** `200 OK` with `{ user, tokens, impersonation }`. Backend sets cookies to the **impersonated user’s** session. Subsequent requests are made as that user until impersonation is stopped.

**Impersonation rules:**

- Target user must exist and have **status: active**.
- Caller cannot impersonate themselves.

**Example**

```json
POST /v1/auth/impersonate
Authorization: Bearer <admin access token>
Cookie: refreshToken=<admin refresh token>
Content-Type: application/json

{ "userId": "69833b2717bacf7be7246008" }
```

**Example response**

```json
{
  "user": { "id": "...", "name": "dummy", "email": "dummy@gmail.com", "role": "user", "roleIds": [...], "status": "active" },
  "tokens": { "access": { "token": "...", "expires": "..." }, "refresh": { "token": "...", "expires": "..." } },
  "impersonation": {
    "impersonationId": "...",
    "by": "<admin user id>",
    "startedAt": "2025-02-04T..."
  }
}
```

---

### 2. Stop impersonation

**POST /v1/auth/stop-impersonation**

- **Auth:** Required. Current session must be an **impersonation** session (i.e. tokens were issued by **POST /v1/auth/impersonate**).
- **Body:** None (or `refreshToken` in body if not using cookie).
- **Response:** `200 OK` with `{ user, tokens }` for the **admin** user. Backend sets cookies to the admin’s session; the admin is no longer impersonating.

If the current session is not an impersonation session, the API returns **400** with message `"Not in impersonation mode"`.

**Example**

```json
POST /v1/auth/stop-impersonation
Cookie: accessToken=<impersonation access token>; refreshToken=<impersonation refresh token>
```

**Example response**

```json
{
  "user": { "id": "...", "name": "Admin", "email": "admin@gmail.com", "role": "admin", "roleIds": [...], "status": "active" },
  "tokens": { "access": { "token": "...", "expires": "..." }, "refresh": { "token": "...", "expires": "..." } }
}
```

---

### 3. Get current user (and impersonation state)

**GET /v1/auth/me**

- When the current session is an **impersonation** session, the response includes an **`impersonation`** object so the UI can show “Viewing as [user]” and an “Exit” action.

**Example response (while impersonating)**

```json
{
  "user": { "id": "...", "name": "dummy", "email": "dummy@gmail.com", ... },
  "impersonation": {
    "by": "<admin user id>",
    "impersonationId": "...",
    "startedAt": "2025-02-04T..."
  }
}
```

When not impersonating, the response is just `{ "user": { ... } }` (no `impersonation`).

---

## Audit (Impersonation model)

Each start of impersonation creates an **Impersonation** document with:

| Field             | Description                                |
|------------------|--------------------------------------------|
| `adminUser`      | User id of the administrator               |
| `impersonatedUser` | User id of the impersonated user        |
| `startedAt`      | When impersonation started                 |
| `endedAt`        | When impersonation ended (null until stop) |
| `adminRefreshToken` | Stored only to restore admin on stop; not returned in APIs (private) |

Queries on this collection provide a full audit of who impersonated whom and when.

---

## Frontend usage

1. **Start impersonation**  
   From an admin context, call **POST /v1/auth/impersonate** with `{ "userId": "<id>" }` and send credentials (cookie or Bearer + refresh token). Replace local user state with the returned `user` and show that the session is impersonation (e.g. “Viewing as [name] – Exit”).

2. **While impersonating**  
   Use **GET /v1/auth/me**; if `impersonation` is present, show “Viewing as [user]” and an “Exit impersonation” control. All other API calls use the same cookies and run as the impersonated user (no extra access).

3. **Stop impersonation**  
   Call **POST /v1/auth/stop-impersonation** with the current credentials. Replace user state with the returned `user` (admin) and clear the impersonation banner.
