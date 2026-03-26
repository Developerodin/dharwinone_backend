# Deployment URLs – Email Links and Share URLs

For deployed environments, **all emails** (reset-password, verify-email, candidate activation, meeting invites, etc.) and **share links** must use your production URLs, not `localhost`. Set the following environment variables in your deployment platform.

---

## Backend (e.g. Render, Railway, Heroku)

| Variable | Purpose | Development | Production Example |
|----------|---------|-------------|--------------------|
| `FRONTEND_BASE_URL` | Base URL for links in emails (reset-password, sign-in, onboarding, etc.) | `http://localhost:3001` | `https://dharwinone.com` |
| `BACKEND_PUBLIC_URL` | Public API URL for document downloads, share links, webhooks | `http://localhost:3000` | `https://apis.dharwinone.com` |
| `GCP_GOOGLE_REDIRECT_URI` | Gmail OAuth callback | `http://localhost:3000/v1/email/auth/google/callback` | `https://apis.dharwinone.com/v1/email/auth/google/callback` |
| `MICROSOFT_REDIRECT_URI` | Outlook OAuth callback | **`/v1/outlook/auth/microsoft/callback`** (recommended). Legacy **`/v1/email/auth/microsoft/callback`** still works. | `https://apis.dharwinone.com/v1/outlook/auth/microsoft/callback` |

Register the same Outlook redirect URI in **Azure Portal** → App → Authentication → Web redirect URIs.

**Example production `.env` (backend):**
```
FRONTEND_BASE_URL=https://dharwinone.com
BACKEND_PUBLIC_URL=https://apis.dharwinone.com
GCP_GOOGLE_REDIRECT_URI=https://apis.dharwinone.com/v1/email/auth/google/callback
MICROSOFT_REDIRECT_URI=https://apis.dharwinone.com/v1/outlook/auth/microsoft/callback
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT_ID=common
```

---

## Frontend (e.g. Vercel, Netlify)

| Variable | Purpose | Development | Production Example |
|----------|---------|-------------|--------------------|
| `NEXT_PUBLIC_API_URL` | API base URL for all API calls | `http://localhost:3000/v1/` | `https://apis.dharwinone.com/v1/` |
| `NEXT_PUBLIC_FRONTEND_URL` | Used for SSR/build-time share links (e.g. job URLs) | `http://localhost:3001` | `https://dharwinone.com` |

**Example production `.env` (frontend):**
```
NEXT_PUBLIC_API_URL=https://apis.dharwinone.com/v1/
NEXT_PUBLIC_FRONTEND_URL=https://dharwinone.com
```

---

## Quick Checklist

- [ ] Backend: `FRONTEND_BASE_URL` set to production frontend URL  
- [ ] Backend: `BACKEND_PUBLIC_URL` set to production API URL  
- [ ] Backend: `GCP_GOOGLE_REDIRECT_URI` updated for Gmail OAuth (if used)  
- [ ] Frontend: `NEXT_PUBLIC_API_URL` set to production API URL  
- [ ] Frontend: `NEXT_PUBLIC_FRONTEND_URL` set to production frontend URL (for share links)  

---

## Where URLs Are Used

- **Reset password / verify email** → `FRONTEND_BASE_URL` (backend)  
- **Candidate activation / onboarding** → `FRONTEND_BASE_URL` (backend)  
- **Meeting join links** → `FRONTEND_BASE_URL` (backend)  
- **Candidate share links** → `BACKEND_PUBLIC_URL` (backend)  
- **Document download links** → `BACKEND_PUBLIC_URL` (backend)  
- **Job share URLs (frontend)** → `NEXT_PUBLIC_FRONTEND_URL` or `window.location.origin`  
- **Gmail OAuth redirect** → `GCP_GOOGLE_REDIRECT_URI`  
