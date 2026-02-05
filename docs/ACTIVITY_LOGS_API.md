# Activity Logs & Audit Trails

All important actions by administrators and significant user actions are recorded for audit and compliance. Logs include actor identity, action, affected entity, and timestamp. They are retained securely and do not expose sensitive personal information.

---

## Requirements (implemented)

- **Administrator actions recorded:** role create/update/delete, permission changes, user create/update/delete/disable, impersonation start/end.
- **User actions:** user management and role changes are recorded with the acting user as actor.
- **Log fields:** actor identity, action performed, affected entity (type + id), timestamp (`createdAt`), optional metadata, ip, userAgent.
- **Retention:** Logs are stored in the `ActivityLog` collection; retention and archival are operational/DB policy.
- **No sensitive PII in logs:** Metadata is sanitized (no passwords, tokens, emails). Actor is populated with `id` and `name` only when returning logs.
- **Review:** Only users with **Administrator** role (by `roleIds`) can list and filter activity logs.
- **Investigation:** Filter by actor, action, entity type/entity id, and date range.

---

## Endpoint: List activity logs

**GET /v1/activity-logs**

- **Auth:** Required. Caller must have **Administrator** role (by `roleIds`).
- **Query (optional):**

| Param      | Type   | Description                                |
|-----------|--------|--------------------------------------------|
| actor     | string | Filter by actor user id (MongoDB ObjectId) |
| action    | string | Filter by action (e.g. `role.create`)      |
| entityType| string | Filter by entity type (`Role`, `User`, `Impersonation`) |
| entityId  | string | Filter by affected entity id               |
| startDate | string | ISO date; logs from this time onward       |
| endDate   | string | ISO date; logs up to this time             |
| sortBy    | string | e.g. `createdAt:desc` (default)            |
| limit     | number | Page size                                  |
| page      | number | Page number                                |

- **Response:** `200 OK` with paginated result:

```json
{
  "results": [
    {
      "id": "...",
      "actor": { "id": "...", "name": "Admin" },
      "action": "role.create",
      "entityType": "Role",
      "entityId": "...",
      "metadata": {},
      "ip": "::1",
      "userAgent": "...",
      "createdAt": "2025-02-04T..."
    }
  ],
  "page": 1,
  "limit": 10,
  "totalPages": 1,
  "totalResults": 5
}
```

Actor is populated with **id and name only** (no email or other PII in the default response).

---

## Actions recorded

| Action                 | entityType   | When |
|------------------------|-------------|------|
| `role.create`         | Role        | Role created |
| `role.update`         | Role        | Role updated (incl. permissions) |
| `role.delete`         | Role        | Role deleted |
| `user.create`         | User        | User created (admin or register) |
| `user.update`         | User        | User updated |
| `user.disable`        | User        | User status set to disabled/deleted |
| `user.delete`         | User        | User deleted |
| `impersonation.start` | Impersonation | Admin started impersonating a user |
| `impersonation.end`   | Impersonation | Admin ended impersonation |

---

## Security and PII

- **Metadata:** Stored metadata must not include passwords, tokens, or full PII. The service strips known sensitive keys from metadata before saving.
- **Actor in response:** Only `id` and `name` are returned when listing logs; no email or other sensitive fields.
- **Access:** Only Administrators can call GET /v1/activity-logs.

---

## Example: Filter logs for a user and date range

```http
GET /v1/activity-logs?actor=6982db99323fa3193546ac6f&startDate=2025-02-01T00:00:00.000Z&endDate=2025-02-05T23:59:59.999Z&limit=20
Authorization: Bearer <admin access token>
```
