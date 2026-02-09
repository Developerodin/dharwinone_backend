# Categories API – Details

API reference for category management within the Training Curriculum module. All endpoints require authentication (JWT via cookie or `Authorization: Bearer`). Permissions: `categories.read` (read), `categories.manage` (create/update/delete).

---

## Base path

```
/v1/training/categories
```

---

## Category schema

| Field         | Type            | Required | Validation / default                          |
|--------------|-----------------|----------|-----------------------------------------------|
| **name**     | string          | Yes      | Unique (case-insensitive), trimmed            |

Response objects also include: `id`, `createdAt`, `updatedAt`.

---

## Endpoints

### 1. Create category

**Request**

| Item   | Value |
|--------|--------|
| Method | `POST` |
| URL    | `/v1/training/categories` |
| Auth   | Bearer or cookie (`categories.manage`) |
| Headers | `Content-Type: application/json` |

**Body (JSON)**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| name | string | Yes | Non-empty, trimmed, unique (case-insensitive) |

**Example body**

```json
{
  "name": "Technical Skills"
}
```

**Success**

- **Status:** `201 Created`
- **Body:** Created category, e.g. `{ id, name, createdAt, updatedAt }`

**Errors**

| Status | When | Example body |
|--------|------|----------------|
| 400 | Validation error | Joi validation payload |
| 400 | Category name already taken | `{ "code": 400, "message": "Category name already taken" }` |
| 401 | Missing or invalid token | `{ "code": 401, "message": "Please authenticate" }` |
| 403 | No `categories.manage` permission | `{ "code": 403, "message": "You do not have permission to perform this action" }` |

---

### 2. List categories

**Request**

| Item   | Value |
|--------|--------|
| Method | `GET` |
| URL    | `/v1/training/categories` |
| Auth   | Bearer or cookie (`categories.read`) |

**Query (optional)**

| Param   | Type   | Description |
|---------|--------|-------------|
| name    | string | Filter by exact name match |
| search  | string | Search in category name (case-insensitive partial match) |
| sortBy  | string | e.g. `createdAt:desc`, `name:asc` (default: `createdAt`) |
| limit   | number | Page size (default: 10) |
| page    | number | Page number (default: 1) |

**Success**

- **Status:** `200 OK`
- **Body:** Paginated result, e.g. `{ results: Category[], page, limit, totalPages, totalResults }`

**Example response**

```json
{
  "results": [
    {
      "id": "6982db99323fa3193546ac6f",
      "name": "Technical Skills",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    },
    {
      "id": "6982db99323fa3193546ac70",
      "name": "Leadership & Management",
      "createdAt": "2024-01-18T14:20:00.000Z",
      "updatedAt": "2024-01-18T14:20:00.000Z"
    }
  ],
  "page": 1,
  "limit": 10,
  "totalPages": 1,
  "totalResults": 2
}
```

**Errors**

| Status | When |
|--------|------|
| 401 | Unauthorized |
| 403 | Forbidden (no `categories.read` permission) |

---

### 3. Get category by ID

**Request**

| Item   | Value |
|--------|--------|
| Method | `GET` |
| URL    | `/v1/training/categories/:categoryId` |
| Auth   | Bearer or cookie (`categories.read`) |

**Params**

| Param      | Type   | Description |
|------------|--------|-------------|
| categoryId | string | MongoDB ObjectId (24 hex characters) |

**Success**

- **Status:** `200 OK`
- **Body:** Single category object

**Example response**

```json
{
  "id": "6982db99323fa3193546ac6f",
  "name": "Technical Skills",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

**Errors**

| Status | When | Example body |
|--------|------|----------------|
| 400 | Invalid categoryId format | Validation payload |
| 401 | Unauthorized | `{ "code": 401, "message": "Please authenticate" }` |
| 403 | Forbidden | `{ "code": 403, "message": "You do not have permission to perform this action" }` |
| 404 | Category not found | `{ "code": 404, "message": "Category not found" }` |

---

### 4. Update category

**Request**

| Item   | Value |
|--------|--------|
| Method | `PATCH` |
| URL    | `/v1/training/categories/:categoryId` |
| Auth   | Bearer or cookie (`categories.manage`) |
| Headers | `Content-Type: application/json` |

**Params**

| Param      | Type   | Description |
|------------|--------|-------------|
| categoryId | string | MongoDB ObjectId |

**Body (JSON, at least one field)**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| name | string | No | Trimmed, unique (case-insensitive, if provided) |

**Example body**

```json
{
  "name": "Advanced Technical Skills"
}
```

**Success**

- **Status:** `200 OK`
- **Body:** Updated category object

**Errors**

| Status | When | Example body |
|--------|------|----------------|
| 400 | Validation error or name already taken | `{ "code": 400, "message": "Category name already taken" }` |
| 401 | Unauthorized | - |
| 403 | Forbidden | - |
| 404 | Category not found | `{ "code": 404, "message": "Category not found" }` |

---

### 5. Delete category

**Request**

| Item   | Value |
|--------|--------|
| Method | `DELETE` |
| URL    | `/v1/training/categories/:categoryId` |
| Auth   | Bearer or cookie (`categories.manage`) |

**Params**

| Param      | Type   | Description |
|------------|--------|-------------|
| categoryId | string | MongoDB ObjectId |

**Success**

- **Status:** `204 No Content`
- **Body:** None

**Errors**

| Status | When | Example body |
|--------|------|--------------|
| 400 | Invalid categoryId | Joi validation payload |
| 401 | Unauthorized | `{ "code": 401, "message": "Please authenticate" }` |
| 403 | Forbidden | `{ "code": 403, "message": "You do not have permission to perform this action" }` |
| 404 | Category not found | `{ "code": 404, "message": "Category not found" }` |

---

## Permissions

Categories API uses the permission-based access control system:

- **`categories.read`** – Required for `GET /v1/training/categories` and `GET /v1/training/categories/:categoryId`
- **`categories.manage`** – Required for `POST /v1/training/categories`, `PATCH /v1/training/categories/:categoryId`, and `DELETE /v1/training/categories/:categoryId`

Permissions are derived from the user's `roleIds` and their associated role `permissions` arrays. The backend dynamically maps domain permissions (e.g., `training.categories:view,create,edit,delete`) to API permissions (`categories.read`, `categories.manage`).

---

## Activity logging

All create, update, and delete operations are automatically logged in the activity log system:

- **Create:** `category.create` action with category name in metadata
- **Update:** `category.update` action with updated category name in metadata
- **Delete:** `category.delete` action

These logs can be viewed via the Activity Logs API (`GET /v1/activity-logs`) by users with appropriate permissions.

---

## cURL examples

**Create category**

```bash
curl -X POST http://localhost:3000/v1/training/categories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{"name":"Technical Skills"}'
```

**List categories**

```bash
curl -X GET "http://localhost:3000/v1/training/categories?search=technical&page=1&limit=10" \
  -H "Authorization: Bearer <access_token>"
```

**Get one category**

```bash
curl -X GET http://localhost:3000/v1/training/categories/<categoryId> \
  -H "Authorization: Bearer <access_token>"
```

**Update category**

```bash
curl -X PATCH http://localhost:3000/v1/training/categories/<categoryId> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{"name":"Advanced Technical Skills"}'
```

**Delete category**

```bash
curl -X DELETE http://localhost:3000/v1/training/categories/<categoryId> \
  -H "Authorization: Bearer <access_token>"
```

Replace `http://localhost:3000` with your API base URL and `<access_token>` with a valid JWT (or rely on the HttpOnly cookie by calling from the same origin with credentials).

---

## Notes

- Category names are **case-insensitive unique**. For example, "Technical Skills" and "technical skills" are considered duplicates.
- The `search` query parameter performs a case-insensitive partial match on the category name.
- All timestamps (`createdAt`, `updatedAt`) are returned in ISO 8601 format (UTC).
- Categories are soft-deleted (removed from database) when deleted. Ensure proper backup and recovery procedures are in place.
