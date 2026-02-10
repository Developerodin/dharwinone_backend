# Student API Implementation Plan

## Overview

This document outlines the plan for implementing student management APIs. The key concept is:
- **User Registration** (`/v1/auth/register`) - Creates a user in the `users` collection
- **Student Registration** (`/v1/auth/register-student`) - Creates a user in the `users` collection **AND** automatically assigns Student role ID
- **Student Profile API** (`/v1/training/students`) - Manages additional student information (personal info, education, experience, documents) that references the `users` table

---

## Architecture

### 1. User Registration vs Student Registration

| Aspect | `/v1/auth/register` | `/v1/auth/register-student` |
|--------|---------------------|----------------------------|
| **Creates** | User record only | User record + Student profile |
| **Role Assignment** | Manual (via `roleIds` in request) | Automatic (Student role ID) |
| **Student Profile** | ❌ Not created | ✅ Created automatically |
| **Use Case** | Admin creates any user | Admin/Student creates student account |

### 2. Data Model Structure

```
┌─────────────────┐
│   Users Table   │  ← Core user data (name, email, password, roleIds, status)
│                 │
│ - id            │
│ - name          │
│ - email         │
│ - password      │
│ - roleIds[]     │  ← Contains Student role ID for students
│ - status        │
└────────┬────────┘
         │
         │ References (user: ObjectId)
         │
         ▼
┌─────────────────┐
│ Students Table  │  ← Extended student information
│                 │
│ - id            │
│ - user (ref)    │  ← Foreign key to Users.id
│ - phone         │
│ - dateOfBirth   │
│ - gender        │
│ - address       │
│ - education[]   │
│ - experience[]  │
│ - skills[]      │
│ - documents[]   │
│ - bio           │
│ - profileImageUrl│
│ - status        │
└─────────────────┘
```

---

## Implementation Plan

### Phase 1: Student Model Schema

**File:** `src/models/student.model.js`

**Schema Fields:**

```javascript
{
  // Reference to User (required, unique)
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true  // One student profile per user
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
  
  // Education (Array)
  education: [{
    degree: String,
    institution: String,
    fieldOfStudy: String,
    startDate: Date,
    endDate: Date,
    isCurrent: Boolean,
    description: String
  }],
  
  // Work Experience (Array)
  experience: [{
    title: String,
    company: String,
    location: String,
    startDate: Date,
    endDate: Date,
    isCurrent: Boolean,
    description: String
  }],
  
  // Skills
  skills: [String],
  
  // Documents (Array)
  documents: [{
    name: String,        // Required
    type: String,        // Required (e.g., 'resume', 'certificate', 'transcript')
    fileUrl: String,     // Optional: URL to document
    fileKey: String,     // Optional: S3 key if using S3
    uploadedAt: Date
  }],
  
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
- `user` field is **required** and **unique** - ensures one student profile per user
- All fields except `user` are optional (can be added/updated later)
- Arrays (education, experience, documents) can be empty initially

---

### Phase 2: Student Registration Service

**File:** `src/services/student.service.js`

**Function:** `registerStudent(studentBody, isAdminRegistration)`

**Logic Flow:**

1. **Find Student Role**
   ```javascript
   const studentRole = await getRoleByName('Student');
   if (!studentRole) {
     throw error('Student role not found');
   }
   ```

2. **Extract Fields**
   - Separate user fields (name, email, password) from student profile fields
   - User fields: `name`, `email`, `password`
   - Student fields: `phone`, `dateOfBirth`, `gender`, `address`, `education`, `experience`, `skills`, `documents`, `bio`, `profileImageUrl`

3. **Create User**
   ```javascript
   const userData = {
     name, email, password,
     roleIds: [studentRole.id],  // ← Automatically assigned
     status: 'active',
     isEmailVerified: isAdminRegistration ? true : false
   };
   const user = await createUser(userData);
   ```

4. **Create Student Profile**
   ```javascript
   const studentData = {
     user: user.id,  // ← Reference to Users table
     phone, dateOfBirth, gender, address,
     education: education || [],
     experience: experience || [],
     skills: skills || [],
     documents: documents || [],
     bio, profileImageUrl,
     status: 'active'
   };
   const student = await Student.create(studentData);
   ```

5. **Return Both**
   ```javascript
   return { user, student };
   ```

---

### Phase 3: Student Registration Endpoint

**File:** `src/controllers/auth.controller.js`

**Endpoint:** `POST /v1/auth/register-student`

**Behavior:**
- **Admin Registration** (with auth token):
  - Creates user + student profile
  - `isEmailVerified = true`
  - No tokens issued
  - Activity logged
  
- **Self-Registration** (no auth token):
  - Creates user + student profile
  - `isEmailVerified = false`
  - Tokens issued
  - Can login immediately

---

### Phase 4: Student CRUD APIs

**Base Path:** `/v1/training/students`

#### 4.1 List Students
- **GET** `/v1/training/students`
- **Auth:** Required (`students.read` permission)
- **Query Params:** `status`, `search`, `sortBy`, `limit`, `page`
- **Response:** Paginated list with user data populated

#### 4.2 Get Student by ID
- **GET** `/v1/training/students/:studentId`
- **Auth:** Required (`students.read` permission)
- **Response:** Single student with user data populated

#### 4.3 Update Student Profile
- **PATCH** `/v1/training/students/:studentId`
- **Auth:** Required (`students.manage` permission)
- **Body:** Any student profile fields (all optional)
- **Response:** Updated student object
- **Activity Log:** Logged

#### 4.4 Delete Student
- **DELETE** `/v1/training/students/:studentId`
- **Auth:** Required (`students.manage` permission)
- **Response:** 204 No Content
- **Activity Log:** Logged

---

### Phase 5: File Structure

```
src/
├── models/
│   └── student.model.js          ← Student schema
├── services/
│   └── student.service.js         ← Business logic
├── controllers/
│   └── student.controller.js      ← Request handlers
├── validations/
│   └── student.validation.js      ← Joi schemas
└── routes/
    └── v1/
        └── student.route.js       ← Route definitions
```

---

## Key Design Decisions

### 1. Why Separate Tables?

**Users Table:**
- Core authentication data
- Shared across all user types (Admin, Manager, Student, etc.)
- Handles login, password, roles

**Students Table:**
- Extended information specific to students
- References Users table via `user` field
- Can be queried independently or joined with Users

### 2. Automatic Student Role Assignment

- Registration endpoint automatically finds "Student" role by name
- Assigns role ID to `user.roleIds[]`
- No need to pass `roleIds` in registration request

### 3. One-to-One Relationship

- `user` field in Students table is **unique**
- Ensures one student profile per user
- Prevents duplicate student profiles

### 4. Optional Profile Fields

- Student profile can be created with minimal data (just user reference)
- Additional fields can be added/updated later via PATCH endpoint
- Allows gradual profile completion

---

## API Endpoints Summary

### Registration
- `POST /v1/auth/register-student` - Register new student (creates User + Student)

### Student Management
- `GET /v1/training/students` - List all students
- `GET /v1/training/students/:studentId` - Get student by ID
- `PATCH /v1/training/students/:studentId` - Update student profile
- `DELETE /v1/training/students/:studentId` - Delete student

---

## Permissions Required

- **`students.read`** - For GET endpoints
- **`students.manage`** - For PATCH and DELETE endpoints

Permissions are derived from role permissions (e.g., `training.students:view,create,edit,delete`)

---

## Data Flow Examples

### Example 1: Student Self-Registration

```
1. POST /v1/auth/register-student
   Body: { name, email, password, phone, skills }
   
2. Backend:
   - Finds Student role → roleId = "abc123"
   - Creates User: { name, email, password, roleIds: ["abc123"], status: "active" }
   - Creates Student: { user: userId, phone, skills, ... }
   
3. Response: { user, student, tokens }
```

### Example 2: Admin Creates Student

```
1. POST /v1/auth/register-student
   Headers: { Authorization: Bearer <admin_token> }
   Body: { name, email, password }
   
2. Backend:
   - Finds Student role → roleId = "abc123"
   - Creates User: { name, email, password, roleIds: ["abc123"], status: "active", isEmailVerified: true }
   - Creates Student: { user: userId, status: "active" }
   
3. Response: { user, student }  (no tokens)
```

### Example 3: Update Student Profile Later

```
1. PATCH /v1/training/students/:studentId
   Body: { 
     education: [{ degree: "BS", institution: "University" }],
     experience: [{ title: "Developer", company: "Tech Corp" }]
   }
   
2. Backend:
   - Updates Student document
   - Logs activity
   
3. Response: Updated student object
```

---

## Next Steps

1. ✅ Create Student model schema
2. ✅ Create Student service (registerStudent, CRUD methods)
3. ✅ Create Student controller
4. ✅ Create Student validation schemas
5. ✅ Create Student routes
6. ✅ Register routes in index.js
7. ✅ Add activity log actions
8. ✅ Update documentation

---

## Testing Checklist

- [ ] Student registration creates both User and Student records
- [ ] Student role ID is automatically assigned
- [ ] Student profile can be created with minimal data
- [ ] Student profile can be updated later
- [ ] List students returns paginated results with user data
- [ ] Get student by ID returns student with populated user
- [ ] Permissions are enforced correctly
- [ ] Activity logs are created for updates/deletes
- [ ] Search functionality works
- [ ] Validation errors are handled properly

---

## Notes

- Student profile is **optional** - a user can exist without a student profile
- Student profile **requires** a user - cannot create student profile without user
- The `user` field in Students table ensures referential integrity
- All student profile fields are optional except `user` reference
- Arrays can be empty or omitted entirely
