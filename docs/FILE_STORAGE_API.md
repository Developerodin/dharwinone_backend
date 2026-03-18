# File Storage API

S3-backed file management scoped to each authenticated user.

## Environment Variables

### Backend (required)

| Variable | Description | Example |
|----------|-------------|---------|
| `AWS_ACCESS_KEY_ID` | AWS IAM access key | `AKIA…` |
| `AWS_SECRET_ACCESS_KEY` | AWS IAM secret key | `wJal…` |
| `AWS_REGION` | S3 bucket region | `ap-south-1` |
| `AWS_S3_BUCKET_NAME` | S3 bucket name | `dharwin-files` |

### Frontend

| Variable | Description | Example |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | Backend base URL (local dev only) | `http://localhost:3000/v1/` |
| `NEXT_PUBLIC_API_BACKEND_URL` | Backend origin for Next.js proxy rewrite | `http://localhost:3000` |

### Proxy (recommended in production)

In `next.config.js`, the `rewrites()` function proxies `/api/v1/:path*` to the backend so the browser always hits the same origin. This avoids CORS and ensures cookies (`SameSite`) work correctly.

For **local dev**, you can set `NEXT_PUBLIC_API_URL` directly (e.g. `http://localhost:3000/v1/`) — the browser-side client uses it as `baseURL`.

For **production**, leave `NEXT_PUBLIC_API_URL` unset or empty so the client uses `/api/v1` (same-origin proxy). Set `NEXT_PUBLIC_API_BACKEND_URL` (or `BACKEND_URL`) to the backend origin for the rewrite destination.

## Endpoints

All routes are mounted at `/v1/file-storage` and require authentication (`auth()` middleware). The user ID is derived server-side from the JWT.

### List objects

```
GET /v1/file-storage/list?prefix=&next=&maxKeys=50
```

| Param | Type | Description |
|-------|------|-------------|
| `prefix` | string (optional) | Folder path within user scope |
| `next` | string (optional) | Continuation token for pagination (max 1024 chars) |
| `maxKeys` | number (optional) | Results per page, 1–1000 (default 50) |

Response:
```json
{
  "success": true,
  "data": {
    "folders": [{ "name": "docs", "prefix": "file-storage/{userId}/docs/" }],
    "files": [{ "key": "…", "name": "report.pdf", "size": 12345, "lastModified": "…" }],
    "nextContinuationToken": "…",
    "isTruncated": false
  }
}
```

Use `nextContinuationToken` as the `next` param for the next page.

### Upload

```
POST /v1/file-storage/upload
Content-Type: multipart/form-data
```

| Field | Type | Description |
|-------|------|-------------|
| `file` | File (required) | The file to upload (max 20 MB) |
| `folder` | string (optional) | Target folder path within user scope |

**Allowed file types:**

- **Images:** jpg, jpeg, png, gif, webp, svg, bmp
- **Documents:** pdf, doc, docx, xls, xlsx, ppt, pptx, txt, csv, html, htm, xml, json, rtf
- **Archives:** zip, rar, 7z, tar, gz
- **Audio:** mp3, wav, ogg, m4a
- **Video:** mp4, webm, mov, avi, mkv

`application/octet-stream` is rejected. The MIME type must match the file extension for known types.

### Download (presigned URL)

```
GET /v1/file-storage/download?key=file-storage/{userId}/docs/report.pdf
```

Returns a short-lived (10 min) presigned S3 URL. The link forces `Content-Disposition: attachment`. If the link expires, request a new one.

### Delete

```
DELETE /v1/file-storage/object?key=file-storage/{userId}/docs/report.pdf
```

## Security

- All routes require authentication; `userId` is server-derived from the JWT.
- Keys are validated to be under the user's prefix (`file-storage/{userId}/`).
- Keys are decoded once (`decodeURIComponent`) before validation; malformed encodings are rejected.
- Path traversal sequences (`..`, `%2e%2e`, `\`) are rejected in keys, prefixes, and folder paths.
- Presigned download URLs have a 10-minute expiry; no user-controlled response headers.
- Upload enforces a 20 MB size limit and MIME/extension allowlists with consistency checking.
- Different users' keys are never exposed; access-denied returns 403 without leaking key existence.
