## Forgot Password & Reset Flow – Frontend Guide

This document explains how the frontend should implement the **forgot password** and **reset password** flow using the existing backend APIs.

Backend endpoints in use:
- `POST /v1/auth/forgot-password`
- `POST /v1/auth/reset-password?token=...`

---

## 1. Forgot Password Page (Request reset email)

**Route (example):** `/forgot-password`

### UI behaviour

- Form with:
  - **Email** input
  - **Submit** button: “Send reset link”
- On submit:
  - Disable the button while the request is in progress.
  - Show success message regardless of whether the email exists (to avoid leaking if an email is registered).

### Request

- **Method:** `POST`
- **URL:** `/v1/auth/forgot-password`
- **Headers:** `Content-Type: application/json`
- **Body:**

```json
{
  "email": "user@example.com"
}
```

### Expected responses (frontend handling)

- **204 No Content**
  - Treat as success: show a generic message such as:
    - “If an account exists for this email, we’ve sent a password reset link.”

- **400 Bad Request**
  - Validation error (e.g. missing or invalid email).
  - Show a form-level error like “Please enter a valid email”.

> The API intentionally never tells you whether the email exists. Always show the same success message on 204.

---

## 2. Reset Password Page (User opens from email)

The reset email contains a link like:

```text
http://localhost:3001/reset-password?token=<JWT_TOKEN>
```

**Route (example):** `/reset-password`

The frontend must:

1. **Read the `token` query parameter** from the URL.
2. If no token is present, show an error message (e.g. “Invalid reset link”).
3. Display a form to enter the new password.

### UI behaviour

- Fields:
  - **New password**
  - (Optional) **Confirm password** (client-side only, to catch typos).
- On submit:
  - Validate password on the client:
    - At least 8 characters
    - At least 1 letter and 1 number
  - Call the reset API with the token.
  - On success (204), redirect to login and show “Password successfully reset, you can now sign in”.

### Request

- **Method:** `POST`
- **URL:** `/v1/auth/reset-password?token=<tokenFromUrl>`
- **Headers:** `Content-Type: application/json`
- **Body:**

```json
{
  "password": "NewSecurePass1"
}
```

> The token comes from the **URL query string**, not from the request body.

### Expected responses (frontend handling)

- **204 No Content**
  - Password was successfully reset.
  - Suggested UX:
    - Show a confirmation message.
    - Redirect to `/login` after a short delay.

- **400 Bad Request**
  - Typical reasons:
    - Missing/invalid token in query.
    - Password did not meet rules (handled by backend).
  - Show a clear error like “Invalid link or password does not meet requirements”.

- **401 Unauthorized**
  - Token is invalid or expired.
  - Show a message like:
    - “This reset link is invalid or has expired. Please request a new password reset.”
  - Offer a button back to `/forgot-password`.

---

## 3. Frontend password rules (to match backend)

The backend enforces:

- Minimum length: **8 characters**
- Must contain **at least one letter** and **at least one number**

The frontend should:

- Validate these rules before sending the request (for better UX).
- Show clear hints under the password field (e.g. a small checklist).

---

## 4. Recommended UX messages

- **Forgot password success:**
  - “If an account exists for this email, we’ve sent a password reset link.”

- **Reset password success:**
  - “Your password has been reset successfully. You can now sign in with your new password.”

- **Expired/invalid token:**
  - “This reset link is invalid or has expired. Please request a new password reset.”

---

## 5. Quick frontend pseudo-code

### Forgot Password form submit

```js
async function onForgotSubmit(email) {
  try {
    await api.post('/v1/auth/forgot-password', { email });
    showMessage('If an account exists for this email, we’ve sent a password reset link.');
  } catch (err) {
    if (err.status === 400) {
      showError('Please enter a valid email address.');
    } else {
      showError('Something went wrong. Please try again later.');
    }
  }
}
```

### Reset Password form submit

```js
async function onResetSubmit(token, password) {
  try {
    await api.post(`/v1/auth/reset-password?token=${encodeURIComponent(token)}`, { password });
    showMessage('Password reset successful. You can now sign in with your new password.');
    navigate('/login');
  } catch (err) {
    if (err.status === 400) {
      showError('Invalid reset link or password does not meet requirements.');
    } else if (err.status === 401) {
      showError('This reset link is invalid or has expired. Please request a new password reset.');
    } else {
      showError('Something went wrong. Please try again later.');
    }
  }
}
```

