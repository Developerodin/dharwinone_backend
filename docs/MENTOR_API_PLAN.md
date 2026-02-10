# Mentor API Implementation Plan

## Overview

This document outlines the plan for implementing mentor management APIs. The key concept is:
- **User Registration** (`/v1/auth/register`) - Creates a user in the `users` collection
- **Mentor Registration** (`/v1/auth/register-mentor`) - Creates a user in the `users` collection **AND** automatically assigns Mentor role ID
- **Mentor Profile API** (`/v1/training/mentors`) - Manages additional mentor information (personal info, expertise, experience, etc.) that references the `users` table

---

## Architecture

### 1. User Registration vs Mentor Registration

| Aspect | `/v1/auth/register` | `/v1/auth/register-mentor` |
|--------|---------------------|----------------------------|
| **Creates** | User record only | User record + Mentor profile |
| **Role Assignment** | Manual (via `roleIds` in request) | Automatic (Mentor role ID) |
| **Mentor Profile** | ❌ Not created | ✅ Created automatically |
| **Use Case** | Admin creates any user | Admin/Mentor creates mentor account |

### 2. Data Model Structure

```
┌─────────────────┐
│   Users Table   │  ← Core user data (name, email, password, roleIds, status)
│                 │
│ - id            │
│ - name          │
│ - email         │
│ - password      │
│ - roleIds[]     │  ← Contains Mentor role ID for mentors
│ - status        │
└────────┬────────┘
         │
         │ References (user: ObjectId)
         │
         ▼
┌─────────────────┐
│  Mentors Table  │  ← Extended mentor information
│                 │
│ - id            │
│ - user (ref)    │  ← Foreign key to Users.id
│ - phone         │
│ - dateOfBirth   │
│ - gender        │
│ - address       │
│ - expertise[]   │  ← Areas of expertise/specialization
│ - experience[]  │
│ - certifications[]│
│ - bio           │
│ - profileImageUrl│
│ - status        │
└─────────────────┘
```

---

## Implementation Plan

### Phase 1: Mentor Model Schema

**File:** `src/models/mentor.model.js`

**Schema Fields:**

```javascript
{
  // Reference to User (required, unique)
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true  // One mentor profile per user
  },
  
  // Personal Information
  phone: String,
  dateOfBirth: Date,
  gender: Enum['male', 'female', 'other'],
  address: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: String
  },
  
  // Expertise/Specialization (Array)
  expertise: [{
    area: String,        // e.g., "Software Development", "Data Science"
    level: String,       // e.g., "Expert", "Advanced", "Intermediate"
    yearsOfExperience: Number,
    description: String
  }],
  
  // Professional Experience (Array)
  experience: [{
    title: String,
    company: String,
    location: String,
    startDate: Date,
    endDate: Date,
    isCurrent: Boolean,
    description: String
  }],
  
  // Certifications (Array)
  certifications: [{
    name: String,        // Required
    issuer: String,      // Required
    issueDate: Date,
    expiryDate: Date,
    credentialId: String,
    credentialUrl: String
  }],
  
  // Skills
  skills: [String],
  
  // Additional Info
  bio: String,
  profileImageUrl: String,
  
  // Status
  status: Enum['active', 'inactive'],
  
  // Timestamps
  createdAt: Date,
  updatedAt: Date
}
```

**Key Points:**
- `user` field is **required** and **unique** - ensures one mentor profile per user
- All fields except `user` are optional (can be added/updated later)
- Arrays (expertise, experience, certifications) can be empty initially

---

### Phase 2: Mentor Registration Service

**File:** `src/services/mentor.service.js`

**Function:** `registerMentor(mentorBody, isAdminRegistration)`

**Logic Flow:**

1. **Find Mentor Role**
   ```javascript
   const mentorRole = await getRoleByName('Mentor');
   if (!mentorRole) {
     throw error('Mentor role not found');
   }
   ```

2. **Extract Fields**
   - Separate user fields (name, email, password) from mentor profile fields
   - User fields: `name`, `email`, `password`
   - Mentor fields: `phone`, `dateOfBirth`, `gender`, `address`, `expertise`, `experience`, `certifications`, `skills`, `bio`, `profileImageUrl`

3. **Create User**
   ```javascript
   const userData = {
     name, email, password,
     roleIds: [mentorRole.id],  // ← Automatically assigned
     status: 'active',
     isEmailVerified: isAdminRegistration ? true : false
   };
   const user = await createUser(userData);
   ```

4. **Create Mentor Profile**
   ```javascript
   const mentorData = {
     user: user.id,  // ← Reference to Users table
     phone, dateOfBirth, gender, address,
     expertise: expertise || [],
     experience: experience || [],
     certifications: certifications || [],
     skills: skills || [],
     bio, profileImageUrl,
     status: 'active'
   };
   const mentor = await Mentor.create(mentorData);
   ```

5. **Return Both**
   ```javascript
   return { user, mentor };
   ```

---

### Phase 3: Mentor Registration Endpoint

**File:** `src/controllers/auth.controller.js`

**Endpoint:** `POST /v1/auth/register-mentor`

**Behavior:**
- **Admin Registration** (with auth token):
  - Creates user + mentor profile
  - `isEmailVerified = true`
  - No tokens issued
  - Activity logged
  
- **Self-Registration** (no auth token):
  - Creates user + mentor profile
  - `isEmailVerified = false`
  - Tokens issued
  - Can login immediately

---

### Phase 4: Mentor CRUD APIs

**Base Path:** `/v1/training/mentors`

#### 4.1 List Mentors
- **GET** `/v1/training/mentors`
- **Auth:** Required (`mentors.read` permission)
- **Query Params:** `status`, `search`, `sortBy`, `limit`, `page`
- **Response:** Paginated list with user data populated

#### 4.2 Get Mentor by ID
- **GET** `/v1/training/mentors/:mentorId`
- **Auth:** Required (`mentors.read` permission)
- **Response:** Single mentor with user data populated

#### 4.3 Update Mentor Profile
- **PATCH** `/v1/training/mentors/:mentorId`
- **Auth:** Required (`mentors.manage` permission)
- **Body:** Any mentor profile fields (all optional)
- **Response:** Updated mentor object
- **Activity Log:** Logged

#### 4.4 Delete Mentor
- **DELETE** `/v1/training/mentors/:mentorId`
- **Auth:** Required (`mentors.manage` permission)
- **Response:** 204 No Content
- **Activity Log:** Logged

---

### Phase 5: File Structure

```
src/
├── models/
│   └── mentor.model.js          ← Mentor schema
├── services/
│   └── mentor.service.js         ← Business logic
├── controllers/
│   └── mentor.controller.js      ← Request handlers
├── validations/
│   └── mentor.validation.js      ← Joi schemas
└── routes/
    └── v1/
        └── mentor.route.js       ← Route definitions
```

---

## Key Design Decisions

### 1. Why Separate Tables?

**Users Table:**
- Core authentication data
- Shared across all user types (Admin, Manager, Student, Mentor, etc.)
- Handles login, password, roles

**Mentors Table:**
- Extended information specific to mentors
- References Users table via `user` field
- Can be queried independently or joined with Users

### 2. Automatic Mentor Role Assignment

- Registration endpoint automatically finds "Mentor" role by name
- Assigns role ID to `user.roleIds[]`
- No need to pass `roleIds` in registration request

### 3. One-to-One Relationship

- `user` field in Mentors table is **unique**
- Ensures one mentor profile per user
- Prevents duplicate mentor profiles

### 4. Optional Profile Fields

- Mentor profile can be created with minimal data (just user reference)
- Additional fields can be added/updated later via PATCH endpoint
- Allows gradual profile completion

---

## API Endpoints Summary

### Registration
- `POST /v1/auth/register-mentor` - Register new mentor (creates User + Mentor)

### Mentor Management
- `GET /v1/training/mentors` - List all mentors
- `GET /v1/training/mentors/:mentorId` - Get mentor by ID
- `PATCH /v1/training/mentors/:mentorId` - Update mentor profile
- `DELETE /v1/training/mentors/:mentorId` - Delete mentor

---

## Permissions Required

- **`mentors.read`** - For GET endpoints
- **`mentors.manage`** - For PATCH and DELETE endpoints

Permissions are derived from role permissions (e.g., `training.mentors:view,create,edit,delete`)

---

## Data Flow Examples

### Example 1: Mentor Self-Registration

```
1. POST /v1/auth/register-mentor
   Body: { name, email, password, phone, expertise }
   
2. Backend:
   - Finds Mentor role → roleId = "xyz789"
   - Creates User: { name, email, password, roleIds: ["xyz789"], status: "active" }
   - Creates Mentor: { user: userId, phone, expertise, ... }
   
3. Response: { user, mentor, tokens }
```

### Example 2: Admin Creates Mentor

```
1. POST /v1/auth/register-mentor
   Headers: { Authorization: Bearer <admin_token> }
   Body: { name, email, password }
   
2. Backend:
   - Finds Mentor role → roleId = "xyz789"
   - Creates User: { name, email, password, roleIds: ["xyz789"], status: "active", isEmailVerified: true }
   - Creates Mentor: { user: userId, status: "active" }
   
3. Response: { user, mentor }  (no tokens)
```

### Example 3: Update Mentor Profile Later

```
1. PATCH /v1/training/mentors/:mentorId
   Body: { 
     expertise: [{ area: "AI/ML", level: "Expert", yearsOfExperience: 10 }],
     certifications: [{ name: "AWS Certified", issuer: "Amazon" }]
   }
   
2. Backend:
   - Updates Mentor document
   - Logs activity
   
3. Response: Updated mentor object
```

---

## Next Steps

1. ✅ Create Mentor model schema
2. ✅ Create Mentor service (registerMentor, CRUD methods)
3. ✅ Create Mentor controller
4. ✅ Create Mentor validation schemas
5. ✅ Create Mentor routes
6. ✅ Register routes in index.js
7. ✅ Add activity log actions
8. ✅ Update documentation

---

## Testing Checklist

- [ ] Mentor registration creates both User and Mentor records
- [ ] Mentor role ID is automatically assigned
- [ ] Mentor profile can be created with minimal data
- [ ] Mentor profile can be updated later
- [ ] List mentors returns paginated results with user data
- [ ] Get mentor by ID returns mentor with populated user
- [ ] Permissions are enforced correctly
- [ ] Activity logs are created for updates/deletes
- [ ] Search functionality works
- [ ] Validation errors are handled properly

---

## Notes

- Mentor profile is **optional** - a user can exist without a mentor profile
- Mentor profile **requires** a user - cannot create mentor profile without user
- The `user` field in Mentors table ensures referential integrity
- All mentor profile fields are optional except `user` reference
- Arrays can be empty or omitted entirely
