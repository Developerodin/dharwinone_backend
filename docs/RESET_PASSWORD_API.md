# Reset Password API

Password reset is a two-step flow: the user requests a reset link via **forgot-password**, then sets a new password via **reset-password** using the token from the email.

---

## 1. Request reset link (forgot password)

**`POST /v1/auth/forgot-password`**

No authentication required. If the email exists, a reset-password token is generated and sent by email. The API always returns 204 so that existence of the email is not revealed.

### Request

**Headers:** `Content-Type: application/json`

**Body:**

| Field   | Type   | Required | Description |
|--------|--------|----------|-------------|
| `email` | string | Yes      | User's email (must be valid email format). |

**Example:**

```json
{
  "email": "user@example.com"
}
```

### Response

- **204 No Content** – Success. If the email is registered, a reset email was sent. If not, no email is sent but the response is still 204.

### Errors

| Status | Description |
|--------|-------------|
| 400    | Validation error (e.g. missing or invalid `email`). |

---

## 2. Set new password (reset password)

**`POST /v1/auth/reset-password`**

No authentication required. The user must provide the token received by email (e.g. from the link in the forgot-password email) and the new password.

### Request

**Token:** passed as **query parameter** `token`.

**Headers:** `Content-Type: application/json`

**Query:**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `token`   | string | Yes      | Reset-password token from the email link. |

**Body:**

| Field      | Type   | Required | Description |
|------------|--------|----------|-------------|
| `password` | string | Yes      | New password. Min 8 characters, at least 1 letter and 1 number. |

**Example:**

```http
POST /v1/auth/reset-password?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "password": "NewSecurePass1"
}
```

### Response

- **204 No Content** – Password was updated. All reset-password tokens for that user are invalidated.

### Errors

| Status | Description |
|--------|-------------|
| 400    | Validation error (e.g. missing `token` in query, or invalid/missing `password`). |
| 401    | Password reset failed (invalid or expired token, or user not found). |

---

## 3. Change password (logged-in user)

**`POST /v1/auth/change-password`**

**Authentication required.** Lets the currently logged-in user set a new password by providing their current password. Use this from a “Change password” or “Security” page in the app.

### Request

**Headers:** `Authorization: Bearer <accessToken>` (or session cookie), `Content-Type: application/json`

**Body:**

| Field             | Type   | Required | Description |
|-------------------|--------|----------|-------------|
| `currentPassword` | string | Yes      | User’s current password. |
| `newPassword`     | string | Yes      | New password. Min 8 characters, at least 1 letter and 1 number. |

**Example:**

```json
{
  "currentPassword": "OldPass123",
  "newPassword": "NewSecurePass1"
}
```

### Response

- **204 No Content** – Password was updated.

### Errors

| Status | Description |
|--------|-------------|
| 400    | Validation error (e.g. missing fields, or `newPassword` does not meet password rules). |
| 401    | Unauthenticated (missing or invalid token) or current password is incorrect. |

---

## Password rules

- Minimum length: **8 characters**
- Must contain **at least one letter** and **at least one number**

---

## Token expiry

Reset-password tokens expire after a configured number of minutes (see `JWT_RESET_PASSWORD_EXPIRATION_MINUTES` in config). Expired tokens return **401 Unauthorized** when used with `POST /v1/auth/reset-password`.

---

## Email link (forgot-password)

The reset email sent by the backend contains a link. By default the URL is:

```
http://link-to-app/reset-password?token=<token>
```

Configure the email template in `src/services/email.service.js` (`sendResetPasswordEmail`) to point to your front-end reset-password page and pass the token (e.g. as query param) so the user can submit it with the new password via `POST /v1/auth/reset-password?token=...`.

---

## Summary

| Endpoint                         | Method | Auth | Purpose |
|----------------------------------|--------|------|---------|
| `/v1/auth/forgot-password`       | POST   | No   | Request reset; sends token by email. |
| `/v1/auth/reset-password?token=` | POST   | No   | Set new password using token from email. |
| `/v1/auth/change-password`       | POST   | Yes  | Change password when logged in (current + new password). |
