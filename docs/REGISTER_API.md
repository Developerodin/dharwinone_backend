# Register User API – Details

API reference for user registration. This endpoint is **public** (no authentication required). On success, the backend creates the user, issues JWT tokens, and sets HttpOnly cookies (`accessToken`, `refreshToken`).

---

## Endpoint

| Item   | Value |
|--------|--------|
| Method | `POST` |
| URL    | `/v1/auth/register` |
| Auth   | None (public) |
| Headers | `Content-Type: application/json` |

---

## Request body – all fields

| Field | Type | Required | Validation / notes |
|-------|------|----------|--------------------|
| **name** | string | Yes | Trimmed; user's full name |
| **email** | string | Yes | Valid email format; stored lowercase; must be **unique** in the system |
| **password** | string | Yes | Min **8 characters**; must contain **at least 1 letter** and **1 number** |
| **isEmailVerified** | boolean | No | Optional; default `false` if omitted |
| **roleIds** | array of strings | No | Optional; array of valid MongoDB ObjectIds (Role IDs); default `[]` if omitted |

**Example request body (minimal)**

```json
{
  "name": "Jane Doe",
  "email": "jane.doe@example.com",
  "password": "password1"
}
```

**Example request body (with optional fields)**

```json
{
  "name": "Nishant Jain",
  "email": "nishant9694536092@gmail.com",
  "password": "Nishant@123",
  "isEmailVerified": true,
  "roleIds": ["6982db99323fa3193546ac6f", "6982dd64323fa3193546acd2"]
}
```

---

## Response – all fields

### Success: `201 Created`

**Body**

| Field | Type | Description |
|-------|------|-------------|
| **user** | object | Created user (see User object below). **Password is never returned.** |
| **tokens** | object | JWT tokens (see Tokens object below). Backend also sets HttpOnly cookies; frontend can ignore this and use cookies. |

**User object (all fields in response)**

| Field | Type | Description |
|-------|------|-------------|
| **id** | string | MongoDB ObjectId as string (e.g. `5ebac534954b54139806c112`) |
| **name** | string | User's name (trimmed) |
| **email** | string | User's email (lowercase) |
| **role** | string | `'user'` \| `'admin'` – registration always sets **`'user'`** |
| **isEmailVerified** | boolean | `false` for new registrations |
| **roleIds** | array of strings | Array of Role IDs; **`[]`** for new registrations |
| **status** | string | `'active'` \| `'disabled'` \| `'deleted'` – new users get **`'active'`** |

Note: `createdAt`, `updatedAt`, and `password` are **not** included in the API response (stripped by the backend).

**Tokens object**

| Field | Type | Description |
|-------|------|-------------|
| **access** | object | Access token and expiry |
| **access.token** | string | JWT access token |
| **access.expires** | string | ISO date-time when access token expires |
| **refresh** | object | Refresh token and expiry |
| **refresh.token** | string | JWT refresh token |
| **refresh.expires** | string | ISO date-time when refresh token expires |

**Example success response**

```json
{
  "user": {
    "id": "5ebac534954b54139806c112",
    "name": "Jane Doe",
    "email": "jane.doe@example.com",
    "role": "user",
    "isEmailVerified": false,
    "roleIds": [],
    "status": "active"
  },
  "tokens": {
    "access": {
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expires": "2025-02-05T10:00:00.000Z"
    },
    "refresh": {
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expires": "2025-02-12T10:00:00.000Z"
    }
  }
}
```

---

## Error responses

| Status | When | Response |
|--------|------|----------|
| **400** | Invalid email format | Joi validation error (e.g. `"email" must be a valid email`) |
| **400** | Password fewer than 8 characters | `"password must be at least 8 characters"` |
| **400** | Password without letter or number | `"password must contain at least 1 letter and 1 number"` |
| **400** | Missing required field (name, email, or password) | Joi validation error listing missing field(s) |
| **400** | Email already taken | `{ "code": 400, "message": "Email already taken" }` |

**Example error body (duplicate email)**

```json
{
  "code": 400,
  "message": "Email already taken"
}
```

---

## Frontend usage

Send the request with credentials so the browser stores the HttpOnly cookies:

```js
// Axios
axios.post('/v1/auth/register', { name, email, password }, { withCredentials: true });

// fetch
await fetch('/v1/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ name, email, password }),
});
```

After registration, use the returned `user` in app state and rely on cookies for authenticated requests. See `AUTH_FRONTEND_GUIDE.md` for full auth flow.
