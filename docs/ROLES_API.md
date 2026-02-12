# Roles API – Details

API reference for role management. All endpoints require authentication (JWT via cookie or `Authorization: Bearer`). Permissions: `getUsers` (read), `manageUsers` (create/update/delete).

---

## Base path

```
/v1/roles
```

--- 

## Role schema

| Field         | Type            | Required | Validation / default                          |
|--------------|-----------------|----------|-----------------------------------------------|
| **name**     | string          | Yes      | Unique, trimmed                               |
| **permissions** | array of strings | No    | Default `[]` (e.g. `ats.jobs:view,create,edit,delete`) |
| **status**   | string          | No       | `'active'` \| `'inactive'`, default `'active'` |

Response objects also include: `id`, `createdAt`, `updatedAt`.

---

## Endpoints

### 1. Create role

**Request**

| Item   | Value |
|--------|--------|
| Method | `POST` |
| URL    | `/v1/roles` |
| Auth   | Bearer or cookie (`manageUsers`) |
| Headers | `Content-Type: application/json` |

**Body (JSON)**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| name | string | Yes | Non-empty, trimmed, unique |
| permissions | array of strings | No | Default `[]` |
| status | string | No | `'active'` or `'inactive'`, default `'active'` |

**Example body**

```json
{
  "name": "Editor",
  "permissions": ["ats.jobs:view,create,edit", "ats.candidates:view"],
  "status": "active"
}
```

**Success**

- **Status:** `201 Created`
- **Body:** Created role, e.g. `{ id, name, permissions, status, createdAt, updatedAt }`

**Errors**

| Status | When | Example body |
|--------|------|----------------|
| 400 | Validation error | Joi validation payload |
| 400 | Role name already taken | `{ "code": 400, "message": "Role name already taken" }` |
| 401 | Missing or invalid token | `{ "code": 401, "message": "Please authenticate" }` |
| 403 | No `manageUsers` right | `{ "code": 403, "message": "Forbidden" }` |

---

### 2. List roles

**Request**

| Item   | Value |
|--------|--------|
| Method | `GET` |
| URL    | `/v1/roles` |
| Auth   | Bearer or cookie (`getUsers`) |

**Query (optional)**

| Param   | Type   | Description |
|---------|--------|-------------|
| name    | string | Filter by name |
| status  | string | `active` or `inactive` |
| sortBy  | string | e.g. `createdAt:desc`, `name:asc` |
| limit   | number | Page size (default from paginate plugin) |
| page    | number | Page number (default 1) |

**Success**

- **Status:** `200 OK`
- **Body:** Paginated result, e.g. `{ results: Role[], page, limit, totalPages, totalResults }`

**Errors**

| Status | When |
|--------|------|
| 401 | Unauthorized |
| 403 | Forbidden |

---

### 3. Get role by ID

**Request**

| Item   | Value |
|--------|--------|
| Method | `GET` |
| URL    | `/v1/roles/:roleId` |
| Auth   | Bearer or cookie (`getUsers`) |

**Params**

| Param  | Type   | Description |
|--------|--------|-------------|
| roleId | string | MongoDB ObjectId (24 hex characters) |

**Success**

- **Status:** `200 OK`
- **Body:** Single role object

**Errors**

| Status | When | Example body |
|--------|------|----------------|
| 400 | Invalid roleId format | Validation payload |
| 401 | Unauthorized | `{ "code": 401, "message": "Please authenticate" }` |
| 403 | Forbidden | `{ "code": 403, "message": "Forbidden" }` |
| 404 | Role not found | `{ "code": 404, "message": "Role not found" }` |

---

### 4. Update role

**Request**

| Item   | Value |
|--------|--------|
| Method | `PATCH` |
| URL    | `/v1/roles/:roleId` |
| Auth   | Bearer or cookie (`manageUsers`) |
| Headers | `Content-Type: application/json` |

**Params**

| Param  | Type   | Description |
|--------|--------|-------------|
| roleId | string | MongoDB ObjectId |

**Body (JSON, at least one field)**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| name | string | No | Trimmed, unique (if provided) |
| permissions | array of strings | No | - |
| status | string | No | `'active'` or `'inactive'` |

**Example body**

```json
{
  "permissions": ["ats.jobs:view,create,edit,delete"],
  "status": "inactive"
}
```

**Success**

- **Status:** `200 OK`
- **Body:** Updated role object

**Errors**

| Status | When | Example body |
|--------|------|----------------|
| 400 | Validation error or name already taken | `{ "code": 400, "message": "Role name already taken" }` |
| 401 | Unauthorized | - |
| 403 | Forbidden | - |
| 404 | Role not found | `{ "code": 404, "message": "Role not found" }` |

---

### 5. Delete role

**Request**

| Item   | Value |
|--------|--------|
| Method | `DELETE` |
| URL    | `/v1/roles/:roleId` |
| Auth   | Bearer or cookie (`manageUsers`) |

**Params**

| Param  | Type   | Description |
|--------|--------|-------------|
| roleId | string | MongoDB ObjectId |

**Success**

- **Status:** `204 No Content`
- **Body:** None

**Errors**

| Status | When | Example body |
|--------|------|--------------|
| 400 | Invalid roleId | Joi validation payload |
| 400 | Role is assigned to active users | `{ "code": 400, "message": "Role cannot be deleted because it is assigned to one or more active users" }` |
| 401 | Unauthorized | `{ "code": 401, "message": "Please authenticate" }` |
| 403 | Forbidden | `{ "code": 403, "message": "Forbidden" }` |
| 404 | Role not found | `{ "code": 404, "message": "Role not found" }` |

---

## Permission format

Permissions are stored as an array of strings. Recommended format per resource:

- **Pattern:** `module.feature:action1,action2,action3`
- **Example:** `ats.jobs:view,create,edit,delete` (one string per resource, comma-separated actions)

Backend does not parse this format; it stores and returns the strings as provided.

---

## cURL examples

**Create role**

```bash
curl -X POST http://localhost:3000/v1/roles \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{"name":"Editor","permissions":["ats.jobs:view,create,edit"],"status":"active"}'
```

**List roles**

```bash
curl -X GET "http://localhost:3000/v1/roles?status=active&page=1&limit=10" \
  -H "Authorization: Bearer <access_token>"
```

**Get one role**

```bash
curl -X GET http://localhost:3000/v1/roles/<roleId> \
  -H "Authorization: Bearer <access_token>"
```

**Update role**

```bash
curl -X PATCH http://localhost:3000/v1/roles/<roleId> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{"permissions":["ats.jobs:view,create,edit,delete"],"status":"inactive"}'
```

**Delete role**

```bash
curl -X DELETE http://localhost:3000/v1/roles/<roleId> \
  -H "Authorization: Bearer <access_token>"
```

Replace `http://localhost:3000` with your API base URL and `<access_token>` with a valid JWT (or rely on the HttpOnly cookie by calling from the same origin with credentials).
