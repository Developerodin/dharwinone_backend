# Mentor Registration API – Frontend Guide

API reference for mentor registration. This endpoint supports both **administrator registration** (admin creates mentor account) and **self-registration** (mentor creates their own account). The Mentor role is automatically assigned.

---

## Base path

```
/v1/auth/register-mentor
```

---

## Endpoint: Register Mentor

**POST `/v1/auth/register-mentor`**

- **Auth:** Optional (required for admin registration, not required for self-registration)
- **Headers:** `Content-Type: application/json`
- **Behavior:**
  - **Admin registration** (with auth token): Mentor created with `isEmailVerified=true`, `status='active'`, **no tokens issued**
  - **Self-registration** (no auth token): Mentor created with `isEmailVerified=false`, `status='active'`, **tokens issued**, mentor can login immediately

---

## Request body

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| **email** | string | Valid email format; stored lowercase; must be **unique** |
| **password** | string | Min **8 characters**; at least **1 letter** and **1 number** |
| **name** | string | Mentor's full name (trimmed) |

### Optional fields (Mentor Profile)

| Field | Type | Description |
|-------|------|-------------|
| **phone** | string | Phone number |
| **dateOfBirth** | date (ISO 8601) | Date of birth |
| **gender** | string | One of: `'male'`, `'female'`, `'other'` |
| **address** | object | Address object (see below) |
| **expertise** | array | Array of expertise entries (see below) |
| **experience** | array | Array of experience entries (see below) |
| **certifications** | array | Array of certification objects (see below) |
| **skills** | array of strings | List of skills (e.g., `["JavaScript", "React", "Node.js"]`) |
| **bio** | string | Biography/description |
| **profileImageUrl** | string | URL to profile image |

### Address object structure

```typescript
{
  street?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
}
```

### Expertise entry structure

```typescript
{
  area?: string;              // e.g., "Software Development", "Data Science"
  level?: string;            // e.g., "Expert", "Advanced", "Intermediate"
  yearsOfExperience?: number;
  description?: string;       // Additional details
}
```

### Experience entry structure

```typescript
{
  title?: string;           // Job title
  company?: string;         // Company name
  location?: string;        // Job location
  startDate?: date;         // ISO 8601 date
  endDate?: date;           // ISO 8601 date (null if current)
  isCurrent?: boolean;      // Default: false
  description?: string;     // Job description/responsibilities
}
```

### Certification object structure

```typescript
{
  name: string;            // Required: Certification name (e.g., "AWS Certified Solutions Architect")
  issuer: string;          // Required: Issuing organization (e.g., "Amazon Web Services")
  issueDate?: date;        // Optional: ISO 8601 date
  expiryDate?: date;       // Optional: ISO 8601 date
  credentialId?: string;   // Optional: Credential ID/number
  credentialUrl?: string;   // Optional: URL to verify credential
}
```

---

## Example requests

### 1. Self-registration (minimal data)

**Request**

```http
POST /v1/auth/register-mentor
Content-Type: application/json

{
  "name": "John Smith",
  "email": "john.smith@example.com",
  "password": "SecurePass123"
}
```

**Response: `201 Created`**

```json
{
  "user": {
    "id": "6982db99323fa3193546ac6f",
    "name": "John Smith",
    "email": "john.smith@example.com",
    "role": "user",
    "roleIds": ["6982db99323fa3193546ac80"],
    "isEmailVerified": false,
    "status": "active",
    "createdAt": "2024-02-09T10:30:00.000Z",
    "updatedAt": "2024-02-09T10:30:00.000Z"
  },
  "mentor": {
    "id": "6982db99323fa3193546ac81",
    "user": "6982db99323fa3193546ac6f",
    "phone": null,
    "dateOfBirth": null,
    "gender": null,
    "address": null,
    "expertise": [],
    "experience": [],
    "certifications": [],
    "skills": [],
    "bio": null,
    "profileImageUrl": null,
    "status": "active",
    "createdAt": "2024-02-09T10:30:00.000Z",
    "updatedAt": "2024-02-09T10:30:00.000Z"
  },
  "tokens": {
    "access": {
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expires": "2024-02-09T11:30:00.000Z"
    },
    "refresh": {
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expires": "2024-02-16T10:30:00.000Z"
    }
  }
}
```

**Note:** For self-registration, tokens are included and cookies are set. The mentor can login immediately.

---

### 2. Self-registration (with full profile data)

**Request**

```http
POST /v1/auth/register-mentor
Content-Type: application/json

{
  "name": "Jane Doe",
  "email": "jane.doe@example.com",
  "password": "SecurePass123",
  "phone": "+1234567890",
  "dateOfBirth": "1985-05-15",
  "gender": "female",
  "address": {
    "street": "123 Main St",
    "city": "New York",
    "state": "NY",
    "zipCode": "10001",
    "country": "USA"
  },
  "expertise": [
    {
      "area": "Software Development",
      "level": "Expert",
      "yearsOfExperience": 15,
      "description": "Full-stack development with focus on modern web technologies"
    },
    {
      "area": "Data Science",
      "level": "Advanced",
      "yearsOfExperience": 8,
      "description": "Machine learning and data analytics"
    }
  ],
  "experience": [
    {
      "title": "Senior Software Engineer",
      "company": "Tech Corp",
      "location": "New York, NY",
      "startDate": "2015-06-01",
      "endDate": null,
      "isCurrent": true,
      "description": "Leading development teams and mentoring junior developers"
    }
  ],
  "certifications": [
    {
      "name": "AWS Certified Solutions Architect",
      "issuer": "Amazon Web Services",
      "issueDate": "2020-03-15",
      "expiryDate": "2023-03-15",
      "credentialId": "AWS-12345",
      "credentialUrl": "https://aws.amazon.com/verification"
    }
  ],
  "skills": ["JavaScript", "React", "Node.js", "Python", "AWS", "Docker"],
  "bio": "Experienced software engineer with 15+ years in full-stack development. Passionate about mentoring and sharing knowledge.",
  "profileImageUrl": "https://example.com/profile.jpg"
}
```

**Response: `201 Created`**

```json
{
  "user": {
    "id": "6982db99323fa3193546ac82",
    "name": "Jane Doe",
    "email": "jane.doe@example.com",
    "role": "user",
    "roleIds": ["6982db99323fa3193546ac80"],
    "isEmailVerified": false,
    "status": "active",
    "createdAt": "2024-02-09T10:30:00.000Z",
    "updatedAt": "2024-02-09T10:30:00.000Z"
  },
  "mentor": {
    "id": "6982db99323fa3193546ac83",
    "user": "6982db99323fa3193546ac82",
    "phone": "+1234567890",
    "dateOfBirth": "1985-05-15T00:00:00.000Z",
    "gender": "female",
    "address": {
      "street": "123 Main St",
      "city": "New York",
      "state": "NY",
      "zipCode": "10001",
      "country": "USA"
    },
    "expertise": [
      {
        "area": "Software Development",
        "level": "Expert",
        "yearsOfExperience": 15,
        "description": "Full-stack development with focus on modern web technologies"
      },
      {
        "area": "Data Science",
        "level": "Advanced",
        "yearsOfExperience": 8,
        "description": "Machine learning and data analytics"
      }
    ],
    "experience": [
      {
        "title": "Senior Software Engineer",
        "company": "Tech Corp",
        "location": "New York, NY",
        "startDate": "2015-06-01T00:00:00.000Z",
        "endDate": null,
        "isCurrent": true,
        "description": "Leading development teams and mentoring junior developers"
      }
    ],
    "certifications": [
      {
        "name": "AWS Certified Solutions Architect",
        "issuer": "Amazon Web Services",
        "issueDate": "2020-03-15T00:00:00.000Z",
        "expiryDate": "2023-03-15T00:00:00.000Z",
        "credentialId": "AWS-12345",
        "credentialUrl": "https://aws.amazon.com/verification"
      }
    ],
    "skills": ["JavaScript", "React", "Node.js", "Python", "AWS", "Docker"],
    "bio": "Experienced software engineer with 15+ years in full-stack development. Passionate about mentoring and sharing knowledge.",
    "profileImageUrl": "https://example.com/profile.jpg",
    "status": "active",
    "createdAt": "2024-02-09T10:30:00.000Z",
    "updatedAt": "2024-02-09T10:30:00.000Z"
  },
  "tokens": {
    "access": {
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expires": "2024-02-09T11:30:00.000Z"
    },
    "refresh": {
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expires": "2024-02-16T10:30:00.000Z"
    }
  }
}
```

---

### 3. Admin registration (administrator creates mentor)

**Request**

```http
POST /v1/auth/register-mentor
Authorization: Bearer <admin_access_token>
Content-Type: application/json

{
  "name": "Alice Johnson",
  "email": "alice.johnson@example.com",
  "password": "TempPassword123",
  "phone": "+1987654321",
  "expertise": [
    {
      "area": "Cloud Architecture",
      "level": "Expert",
      "yearsOfExperience": 10
    }
  ]
}
```

**Response: `201 Created`**

```json
{
  "user": {
    "id": "6982db99323fa3193546ac84",
    "name": "Alice Johnson",
    "email": "alice.johnson@example.com",
    "role": "user",
    "roleIds": ["6982db99323fa3193546ac80"],
    "isEmailVerified": true,
    "status": "active",
    "createdAt": "2024-02-09T10:30:00.000Z",
    "updatedAt": "2024-02-09T10:30:00.000Z"
  },
  "mentor": {
    "id": "6982db99323fa3193546ac85",
    "user": "6982db99323fa3193546ac84",
    "phone": "+1987654321",
    "dateOfBirth": null,
    "gender": null,
    "address": null,
    "expertise": [
      {
        "area": "Cloud Architecture",
        "level": "Expert",
        "yearsOfExperience": 10,
        "description": null
      }
    ],
    "experience": [],
    "certifications": [],
    "skills": [],
    "bio": null,
    "profileImageUrl": null,
    "status": "active",
    "createdAt": "2024-02-09T10:30:00.000Z",
    "updatedAt": "2024-02-09T10:30:00.000Z"
  }
}
```

**Note:** For admin registration, **no tokens are included** and **no cookies are set**. The admin remains logged in. The mentor's email is automatically verified (`isEmailVerified: true`).

---

## Error responses

| Status | When | Response |
|--------|------|----------|
| **400** | Validation error (invalid email, password rules, missing required field) | Joi validation error payload |
| **400** | Email already taken | `{ "code": 400, "message": "Email already taken" }` |
| **500** | Mentor role not found in database | `{ "code": 500, "message": "Mentor role not found. Please contact administrator." }` |

**Example validation error:**

```json
{
  "code": 400,
  "message": "Validation error",
  "errors": [
    {
      "field": "password",
      "message": "password must be at least 8 characters"
    },
    {
      "field": "email",
      "message": "\"email\" must be a valid email"
    }
  ]
}
```

---

## Key differences: Admin vs Self-registration

| Aspect | Admin Registration | Self-registration |
|--------|-------------------|-------------------|
| **Authentication** | Required (Bearer token) | Not required |
| **Email verified** | `true` (automatic) | `false` (mentor must verify) |
| **Status** | `active` | `active` |
| **Tokens issued** | ❌ No | ✅ Yes |
| **Cookies set** | ❌ No | ✅ Yes |
| **Can login immediately** | ✅ Yes (but no tokens, so must use login endpoint) | ✅ Yes (tokens provided) |
| **Activity logged** | ✅ Yes (admin action logged) | ❌ No |

---

## Frontend implementation guide

### Self-registration flow

1. **Display registration form** with fields for:
   - Required: name, email, password
   - Optional: phone, dateOfBirth, gender, address, expertise, experience, certifications, skills, bio, profileImageUrl

2. **Submit registration:**
   ```javascript
   const response = await fetch('/v1/auth/register-mentor', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
     },
     body: JSON.stringify({
       name: formData.name,
       email: formData.email,
       password: formData.password,
       // ... other optional fields
     }),
   });
   
   if (response.ok) {
     const data = await response.json();
     // Store tokens
     localStorage.setItem('accessToken', data.tokens.access.token);
     localStorage.setItem('refreshToken', data.tokens.refresh.token);
     // Redirect to dashboard
     window.location.href = '/dashboard';
   }
   ```

3. **Handle success:**
   - Store tokens (if self-registration)
   - Redirect to dashboard or mentor profile page
   - Show success message

4. **Handle errors:**
   - Display validation errors
   - Show appropriate error messages

### Admin registration flow

1. **Display registration form** (admin panel)
2. **Submit with admin token:**
   ```javascript
   const response = await fetch('/v1/auth/register-mentor', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'Authorization': `Bearer ${adminAccessToken}`,
     },
     body: JSON.stringify({
       name: formData.name,
       email: formData.email,
       password: formData.password,
       // ... other fields
     }),
   });
   
   if (response.ok) {
     const data = await response.json();
     // Show success message
     // Optionally send welcome email to mentor
     // Refresh mentor list
   }
   ```

3. **Handle success:**
   - Show success message
   - Optionally send welcome email to mentor with login credentials
   - Refresh mentor list in admin panel

---

## Mentor role assignment

- The **Mentor role ID is automatically assigned** when registering a mentor
- The system finds the role by name "Mentor" (case-insensitive)
- If the Mentor role doesn't exist in the database, registration will fail with a 500 error
- Ensure the Mentor role exists before allowing registrations

---

## Email verification

- **Self-registration:** Mentor receives email verification token (if email service is configured)
- **Admin registration:** Email is automatically verified (`isEmailVerified: true`)
- Mentors can verify their email later using `POST /v1/auth/verify-email`

---

## Password rules

- Minimum length: **8 characters**
- Must contain **at least one letter** and **at least one number**
- Example valid passwords: `Password1`, `Secure123`, `MyPass2024`

---

## cURL examples

### Self-registration

```bash
curl -X POST http://localhost:3000/v1/auth/register-mentor \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Smith",
    "email": "john.smith@example.com",
    "password": "SecurePass123",
    "phone": "+1234567890",
    "skills": ["JavaScript", "React"]
  }'
```

### Admin registration

```bash
curl -X POST http://localhost:3000/v1/auth/register-mentor \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin_access_token>" \
  -d '{
    "name": "Jane Doe",
    "email": "jane.doe@example.com",
    "password": "TempPassword123",
    "phone": "+1987654321"
  }'
```

---

## Notes

- All dates should be in **ISO 8601 format** (e.g., `"1985-05-15"` or `"1985-05-15T00:00:00.000Z"`)
- Empty strings (`""`) and `null` are accepted for optional fields
- Arrays can be empty (`[]`) or omitted entirely
- The Mentor role is automatically assigned - do not include `roleIds` in the request
- For self-registration, tokens are returned in the response body and also set as HttpOnly cookies
- Mentors registered by admin can login immediately using `POST /v1/auth/login` with their email and password

---

# Mentor Management API – CRUD Operations

API reference for managing mentor profiles. All endpoints require authentication (JWT via cookie or `Authorization: Bearer`). Permissions: `mentors.read` (read), `mentors.manage` (update/delete).

---

## Base path

```
/v1/training/mentors
```

---

## Endpoints

### 1. List mentors

**Request**

| Item   | Value |
|--------|--------|
| Method | `GET` |
| URL    | `/v1/training/mentors` |
| Auth   | Bearer or cookie (`mentors.read`) |

**Query (optional)**

| Param   | Type   | Description |
|---------|--------|-------------|
| status  | string | Filter by status: `active` or `inactive` |
| search  | string | Search in mentor phone number (case-insensitive partial match) |
| sortBy  | string | e.g. `createdAt:desc`, `updatedAt:asc` (default: `createdAt`) |
| limit   | number | Page size (default: 10) |
| page    | number | Page number (default: 1) |

**Success**

- **Status:** `200 OK`
- **Body:** Paginated result with mentor profiles (user data populated)

**Example response**

```json
{
  "results": [
    {
      "id": "6982db99323fa3193546ac81",
      "user": {
        "id": "6982db99323fa3193546ac6f",
        "name": "John Smith",
        "email": "john.smith@example.com",
        "role": "user",
        "roleIds": ["6982db99323fa3193546ac80"],
        "status": "active",
        "isEmailVerified": false
      },
      "phone": "+1234567890",
      "dateOfBirth": "1985-05-15T00:00:00.000Z",
      "gender": "male",
      "address": {
        "street": "123 Main St",
        "city": "New York",
        "state": "NY",
        "zipCode": "10001",
        "country": "USA"
      },
      "expertise": [
        {
          "area": "Software Development",
          "level": "Expert",
          "yearsOfExperience": 15,
          "description": "Full-stack development"
        }
      ],
      "experience": [],
      "certifications": [],
      "skills": ["JavaScript", "React"],
      "bio": null,
      "profileImageUrl": null,
      "status": "active",
      "createdAt": "2024-02-09T10:30:00.000Z",
      "updatedAt": "2024-02-09T10:30:00.000Z"
    }
  ],
  "page": 1,
  "limit": 10,
  "totalPages": 1,
  "totalResults": 1
}
```

**Errors**

| Status | When |
|--------|------|
| 401 | Unauthorized |
| 403 | Forbidden (no `mentors.read` permission) |

---

### 2. Get mentor by ID

**Request**

| Item   | Value |
|--------|--------|
| Method | `GET` |
| URL    | `/v1/training/mentors/:mentorId` |
| Auth   | Bearer or cookie (`mentors.read`) |

**Params**

| Param    | Type   | Description |
|----------|--------|-------------|
| mentorId | string | MongoDB ObjectId (24 hex characters) |

**Success**

- **Status:** `200 OK`
- **Body:** Single mentor object with populated user data

**Example response**

```json
{
  "id": "6982db99323fa3193546ac81",
  "user": {
    "id": "6982db99323fa3193546ac6f",
    "name": "John Smith",
    "email": "john.smith@example.com",
    "role": "user",
    "roleIds": ["6982db99323fa3193546ac80"],
    "status": "active",
    "isEmailVerified": false
  },
  "phone": "+1234567890",
  "dateOfBirth": "1985-05-15T00:00:00.000Z",
  "gender": "male",
  "address": {
    "street": "123 Main St",
    "city": "New York",
    "state": "NY",
    "zipCode": "10001",
    "country": "USA"
  },
  "expertise": [
    {
      "area": "Software Development",
      "level": "Expert",
      "yearsOfExperience": 15,
      "description": "Full-stack development with focus on modern web technologies"
    }
  ],
  "experience": [
    {
      "title": "Senior Software Engineer",
      "company": "Tech Corp",
      "location": "New York, NY",
      "startDate": "2015-06-01T00:00:00.000Z",
      "endDate": null,
      "isCurrent": true,
      "description": "Leading development teams"
    }
  ],
  "certifications": [
    {
      "name": "AWS Certified Solutions Architect",
      "issuer": "Amazon Web Services",
      "issueDate": "2020-03-15T00:00:00.000Z",
      "expiryDate": "2023-03-15T00:00:00.000Z",
      "credentialId": "AWS-12345",
      "credentialUrl": "https://aws.amazon.com/verification"
    }
  ],
  "skills": ["JavaScript", "React", "Node.js", "Python"],
  "bio": "Experienced software engineer with 15+ years in full-stack development.",
  "profileImageUrl": "https://example.com/profile.jpg",
  "status": "active",
  "createdAt": "2024-02-09T10:30:00.000Z",
  "updatedAt": "2024-02-09T10:30:00.000Z"
}
```

**Errors**

| Status | When | Example body |
|--------|------|----------------|
| 400 | Invalid mentorId format | Validation payload |
| 401 | Unauthorized | `{ "code": 401, "message": "Please authenticate" }` |
| 403 | Forbidden | `{ "code": 403, "message": "You do not have permission to perform this action" }` |
| 404 | Mentor not found | `{ "code": 404, "message": "Mentor not found" }` |

---

### 3. Update mentor

**Request**

| Item   | Value |
|--------|--------|
| Method | `PATCH` |
| URL    | `/v1/training/mentors/:mentorId` |
| Auth   | Bearer or cookie (`mentors.manage`) |
| Headers | `Content-Type: application/json` |

**Params**

| Param    | Type   | Description |
|----------|--------|-------------|
| mentorId | string | MongoDB ObjectId |

**Body (JSON, at least one field)**

All fields from mentor profile are optional (same structure as registration). See registration API for field definitions.

**Example body**

```json
{
  "phone": "+1987654321",
  "expertise": [
    {
      "area": "Cloud Architecture",
      "level": "Expert",
      "yearsOfExperience": 10
    }
  ],
  "certifications": [
    {
      "name": "Google Cloud Professional Architect",
      "issuer": "Google Cloud",
      "issueDate": "2023-01-15"
    }
  ],
  "skills": ["JavaScript", "React", "Node.js", "AWS", "GCP"],
  "bio": "Updated bio text",
  "status": "active"
}
```

**Success**

- **Status:** `200 OK`
- **Body:** Updated mentor object

**Errors**

| Status | When | Example body |
|--------|------|----------------|
| 400 | Validation error | Joi validation payload |
| 401 | Unauthorized | - |
| 403 | Forbidden | - |
| 404 | Mentor not found | `{ "code": 404, "message": "Mentor not found" }` |

---

### 4. Delete mentor

**Request**

| Item   | Value |
|--------|--------|
| Method | `DELETE` |
| URL    | `/v1/training/mentors/:mentorId` |
| Auth   | Bearer or cookie (`mentors.manage`) |

**Params**

| Param    | Type   | Description |
|----------|--------|-------------|
| mentorId | string | MongoDB ObjectId |

**Success**

- **Status:** `204 No Content`
- **Body:** None

**Errors**

| Status | When | Example body |
|--------|------|--------------|
| 400 | Invalid mentorId | Joi validation payload |
| 401 | Unauthorized | `{ "code": 401, "message": "Please authenticate" }` |
| 403 | Forbidden | `{ "code": 403, "message": "You do not have permission to perform this action" }` |
| 404 | Mentor not found | `{ "code": 404, "message": "Mentor not found" }` |

---

## Permissions

Mentor Management API uses the permission-based access control system:

- **`mentors.read`** – Required for `GET /v1/training/mentors` and `GET /v1/training/mentors/:mentorId`
- **`mentors.manage`** – Required for `PATCH /v1/training/mentors/:mentorId` and `DELETE /v1/training/mentors/:mentorId`

Permissions are derived from the user's `roleIds` and their associated role `permissions` arrays. The backend dynamically maps domain permissions (e.g., `training.mentors:view,create,edit,delete`) to API permissions (`mentors.read`, `mentors.manage`).

---

## Activity logging

All update and delete operations are automatically logged in the activity log system:

- **Update:** `mentor.update` action
- **Delete:** `mentor.delete` action

These logs can be viewed via the Activity Logs API (`GET /v1/activity-logs`) by users with appropriate permissions.

---

## cURL examples

**List mentors**

```bash
curl -X GET "http://localhost:3000/v1/training/mentors?status=active&page=1&limit=10" \
  -H "Authorization: Bearer <access_token>"
```

**Get one mentor**

```bash
curl -X GET http://localhost:3000/v1/training/mentors/<mentorId> \
  -H "Authorization: Bearer <access_token>"
```

**Update mentor**

```bash
curl -X PATCH http://localhost:3000/v1/training/mentors/<mentorId> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{
    "expertise": [
      {
        "area": "Cloud Architecture",
        "level": "Expert",
        "yearsOfExperience": 10
      }
    ],
    "skills": ["JavaScript", "React", "AWS"],
    "bio": "Updated bio"
  }'
```

**Delete mentor**

```bash
curl -X DELETE http://localhost:3000/v1/training/mentors/<mentorId> \
  -H "Authorization: Bearer <access_token>"
```

Replace `http://localhost:3000` with your API base URL and `<access_token>` with a valid JWT (or rely on the HttpOnly cookie by calling from the same origin with credentials).
