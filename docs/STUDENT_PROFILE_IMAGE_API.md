## Student Profile Image API

This document describes how the **Student Profile Image** flow works in the Dharwin backend using AWS S3 presigned URLs.

---

### Overview

- **Goal**: Allow uploading a profile image for a student and storing its reference on the `Student` document.
- **Storage**: AWS S3 (configured via `AWS_*` env vars).
- **Pattern**: 2-step presigned URL upload:
  1. Backend returns a **presigned S3 PUT URL** for the image.
  2. Frontend uploads directly to S3, then updates the `Student` with the image key/URL.

Relevant code:

- `src/routes/v1/student.route.js`
- `src/controllers/student.controller.js`
- `src/validations/student.validation.js`
- `src/services/upload.service.js`
- `src/config/s3.js`

---

### 1. Get Presigned Upload URL (Profile Image)

**Endpoint**

- **Method**: `POST`
- **URL**: `/v1/students/:studentId/profile-image/upload-url`
- **Auth**: Required (`Authorization: Bearer <token>`)
- **Permissions**: `students.manage`

**Path Params**

- `studentId` (string, MongoDB ObjectId) – ID of the student whose profile image is being uploaded.

**Request Body**

```json
{
  "fileName": "avatar.png",
  "contentType": "image/png"
}
```

- `fileName` (string, required): Original file name; used to infer the extension.
- `contentType` (string, required): MIME type, e.g. `image/png`, `image/jpeg`.

**Success Response – 200 OK**

```json
{
  "bucket": "vsc-files-storage",
  "key": "profile-images/<userId>/<timestamp>-<random>.png",
  "url": "https://s3-<region>.amazonaws.com/...",
  "expiresIn": 3600
}
```

- `bucket`: S3 bucket name.
- `key`: S3 object key for the profile image (to be stored on the `Student`).
- `url`: Presigned S3 URL for a `PUT` upload.
- `expiresIn`: Expiry in seconds for the presigned URL.

**Error Responses**

- `401 / 403` – Not authenticated or missing `students.manage` permission.
- `404` – Student not found.
- `400` – Validation error (missing/invalid `fileName` or `contentType`).

---

### 2. Upload Image to S3 (Frontend → S3)

This step is performed **directly by the frontend against S3** using the presigned URL.

**Request**

- **Method**: `PUT`
- **URL**: `url` returned from step 1.
- **Headers**:
  - `Content-Type: <contentType from step 1>`
- **Body**:
  - Raw image file bytes.

**Success Response**

- Typically `200 OK` or `204 No Content` from S3.
- No JSON body is returned.

> If this request succeeds, the image is now stored in S3 under the `key` returned in step 1.

---

### 3. Save Profile Image on the Student

After the upload to S3 succeeds, the frontend must update the `Student` document to reference the uploaded image.

We reuse the existing **Update Student** API.

**Endpoint**

- **Method**: `PATCH`
- **URL**: `/v1/students/:studentId`
- **Auth**: Required
- **Permissions**: `students.manage`

**Path Params**

- `studentId` (string, MongoDB ObjectId)

**Request Body Example**

Using the S3 key:

```json
{
  "profileImageUrl": "profile-images/<userId>/<timestamp>-<random>.png"
}
```

Or using a fully qualified S3 URL if the frontend generates it:

```json
{
  "profileImageUrl": "https://vsc-files-storage.s3.ap-south-1.amazonaws.com/profile-images/<userId>/<timestamp>-<random>.png"
}
```

**Success Response – 200 OK**

```json
{
  "id": "64f0c2...",
  "user": { "...": "..." },
  "phone": null,
  "education": [],
  "experience": [],
  "skills": [],
  "documents": [],
  "bio": null,
  "profileImageUrl": "profile-images/<userId>/<timestamp>-<random>.png",
  "status": "active",
  "createdAt": "2026-02-10T12:34:56.789Z",
  "updatedAt": "2026-02-10T12:35:10.123Z"
}
```

---

### 4. Typical Frontend Flow

1. **Request presigned upload URL**
   - `POST /v1/students/:studentId/profile-image/upload-url`
   - Receive `{ bucket, key, url, expiresIn }`.

2. **Upload image to S3**
   - `PUT` the file to `url` with the correct `Content-Type`.

3. **Persist reference on student**
   - `PATCH /v1/students/:studentId` with `{ "profileImageUrl": "<key or full URL>" }`.

4. **Render in UI**
   - Use `student.profileImageUrl` to display the avatar, either as:
     - Direct S3 URL, or
     - Through a backend endpoint that generates a presigned download URL (future enhancement if needed).

---

### 5. Notes

- `profileImageUrl` is a simple string field on `Student`; the backend does not enforce a particular format.
- The presigned URL is **time-limited**; uploads must happen before `expiresIn` seconds elapse.
- AWS credentials and bucket details are configured via:
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
  - `AWS_REGION`
  - `AWS_S3_BUCKET_NAME`

