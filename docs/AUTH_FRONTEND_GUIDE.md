## Auth & Cookies – Frontend Guide

### Overview

- Backend uses **JWT tokens** plus **HttpOnly cookies**.
- Frontend should **not store tokens** (no localStorage/sessionStorage).
- Browser automatically manages cookies; frontend just sends requests **with credentials**.

---

### Endpoints

- `POST /v1/auth/register` – register user
- `POST /v1/auth/login` – login user
- `GET /v1/auth/me` – get current authenticated user (requires auth)
- `POST /v1/auth/refresh-tokens` – get new tokens when access token expires
- `POST /v1/auth/logout` – logout user

All return:

```json
{
  "user": { "...": "..." },
  "tokens": {
    "access": { "token": "...", "expires": "..." },
    "refresh": { "token": "...", "expires": "..." }
  }
}
```

> Frontend should ignore `tokens` and rely on cookies instead.

---

### Cookies set by backend

On **successful register/login/refresh**, backend sends:

- `accessToken`
  - JWT access token
  - `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`
  - Expires with access token
- `refreshToken`
  - JWT refresh token
  - `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`
  - Expires with refresh token

On **logout**, backend clears both cookies.

Because they are **HttpOnly**, JavaScript **cannot read or write** these cookies.

---

### How to call APIs from frontend

#### Login / Register

Use `withCredentials: true` (Axios) or `credentials: 'include'` (fetch).

```js
// Axios
axios.post(
  '/v1/auth/login',
  { email, password },
  { withCredentials: true },
);
```

```js
// fetch
await fetch('/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ email, password }),
});
```

After this, browser stores cookies automatically. Frontend should keep only the `user` object in its state.

#### Authenticated requests

For any protected endpoint (e.g. `/v1/users`, `/v1/roles`):

```js
axios.get('/v1/users', { withCredentials: true });
// or
fetch('/v1/users', { credentials: 'include' });
```

Do **not** manually add `Authorization` headers with tokens.

#### Get current user (/me)

Use this to restore user state on app load (e.g. after refresh) when cookies are still valid:

```js
axios.get('/v1/auth/me', { withCredentials: true });
// or
fetch('/v1/auth/me', { credentials: 'include' });
```

Returns the authenticated user object (e.g. `id`, `email`, `name`, `role`, `roleIds`, `status`). On 401, user is not logged in or session expired.

#### Refresh tokens

On 401 due to expired access token, call with credentials only (no body required; refresh token is read from the HttpOnly cookie):

```js
await axios.post('/v1/auth/refresh-tokens', {}, { withCredentials: true });
// or
await fetch('/v1/auth/refresh-tokens', { method: 'POST', credentials: 'include' });
```

Backend reads `refreshToken` from the cookie, issues new tokens, and sets new cookies.

#### Logout

Call with credentials only (no body required; refresh token is read from the HttpOnly cookie):

```js
await axios.post('/v1/auth/logout', {}, { withCredentials: true });
// or
await fetch('/v1/auth/logout', { method: 'POST', credentials: 'include' });
```

Backend reads `refreshToken` from the cookie, invalidates it in the DB, and clears the auth cookies. Frontend should clear in‑memory user state and redirect to login.

---

### Important notes

- Backend CORS is configured to allow `credentials: true`. Set `config.corsOrigin` to your frontend URL in backend config.
- Only users with `status: 'active'` can:
  - Login
  - Refresh tokens
  - Access protected APIs

