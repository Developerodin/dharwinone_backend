# Student Courses API - Implementation Plan

## Overview

This document outlines the architecture and implementation plan for a **Student Courses** system that allows students to:
- View courses assigned to them via Training Modules
- Track course progress (start date, completion percentage)
- Take quizzes and track scores
- Receive certificates upon 100% completion

The system follows a **Udemy-like architecture** with progress tracking, quiz scoring, and certificate generation.

---

## Important: Course = Training Module

**Key Concept**: 
- **TrainingModule** = **Course** (they are the same entity)
- Course details (name, description, cover image, playlist items, quizzes) come from the **TrainingModule** model
- **StudentCourseProgress** only tracks the student's progress/enrollment state
- When a student views their courses, we:
  1. Find all TrainingModules where `students` array contains the student's ID
  2. Join with StudentCourseProgress to get progress data
  3. Return combined data: Module details + Progress tracking

**Data Flow**:
```
TrainingModule (Course Content)
    ├── moduleName (Course Name)
    ├── shortDescription
    ├── coverImage
    ├── playlist[] (Course Content Items)
    │   ├── Videos
    │   ├── PDFs
    │   ├── Blogs
    │   └── Quizzes
    └── students[] (Assigned Students)

StudentCourseProgress (Progress Tracking)
    ├── student (ref to Student)
    ├── module (ref to TrainingModule)
    ├── progress.percentage
    ├── progress.completedItems[]
    └── quizScores
```

**API Response Example**:
```json
{
  "module": {
    "id": "...",
    "moduleName": "JavaScript Fundamentals",
    "shortDescription": "...",
    "coverImage": {...},
    "playlist": [...]
  },
  "progress": {
    "percentage": 65,
    "completedItems": [...],
    "quizScores": {...}
  }
}
```

---

## 1. Data Models

### 1.1 StudentCourseProgress Model (New)

**Purpose**: Track a student's enrollment and progress in a specific course (Training Module).

**Schema**:
```javascript
{
  student: {
    type: ObjectId,
    ref: 'Student',
    required: true,
    index: true
  },
  module: {
    type: ObjectId,
    ref: 'TrainingModule',
    required: true,
    index: true
  },
  // Enrollment
  enrolledAt: {
    type: Date,
    default: Date.now
  },
  startedAt: {
    type: Date, // When student first accessed the course
  },
  completedAt: {
    type: Date, // When student reached 100%
  },
  // Progress tracking
  progress: {
    percentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    completedItems: [{
      playlistItemId: {
        type: String, // Reference to playlist item (by order/index or unique ID)
        required: true
      },
      completedAt: {
        type: Date,
        default: Date.now
      },
      contentType: {
        type: String,
        enum: ['upload-video', 'youtube-link', 'pdf-document', 'blog', 'quiz', 'test']
      }
    }],
    lastAccessedAt: {
      type: Date,
      default: Date.now
    },
    lastAccessedItem: {
      playlistItemId: String, // Last playlist item student viewed
    }
  },
  // Quiz scores (aggregated from StudentQuizAttempt)
  quizScores: {
    totalQuizzes: {
      type: Number,
      default: 0
    },
    completedQuizzes: {
      type: Number,
      default: 0
    },
    averageScore: {
      type: Number,
      default: 0
    },
    totalScore: {
      type: Number,
      default: 0
    }
  },
  // Certificate
  certificate: {
    issued: {
      type: Boolean,
      default: false
    },
    issuedAt: {
      type: Date
    },
    certificateId: {
      type: String, // Unique certificate ID/URL
      trim: true
    },
    certificateUrl: {
      type: String, // URL to download/view certificate
      trim: true
    }
  },
  // Status
  status: {
    type: String,
    enum: ['enrolled', 'in-progress', 'completed', 'dropped'],
    default: 'enrolled'
  }
}
```

**Indexes**:
- Compound index: `{ student: 1, module: 1 }` (unique) - one progress record per student per module
- Index on `student` for quick lookups
- Index on `module` for analytics

---

### 1.2 StudentQuizAttempt Model (New)

**Purpose**: Track individual quiz attempts and scores.

**Schema**:
```javascript
{
  student: {
    type: ObjectId,
    ref: 'Student',
    required: true,
    index: true
  },
  module: {
    type: ObjectId,
    ref: 'TrainingModule',
    required: true,
    index: true
  },
  playlistItemId: {
    type: String, // Reference to the quiz item in module.playlist
    required: true
  },
  // Quiz attempt details
  attemptNumber: {
    type: Number,
    default: 1 // 1st attempt, 2nd attempt, etc.
  },
  answers: [{
    questionIndex: {
      type: Number, // Index of question in quiz.questions array
      required: true
    },
    selectedOptions: [{
      type: Number // Indices of selected options
    }],
    isCorrect: {
      type: Boolean
    },
    pointsEarned: {
      type: Number,
      default: 0
    }
  }],
  // Scoring
  score: {
    totalQuestions: {
      type: Number,
      required: true
    },
    correctAnswers: {
      type: Number,
      default: 0
    },
    percentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    totalPoints: {
      type: Number,
      default: 0
    },
    maxPoints: {
      type: Number,
      required: true
    }
  },
  // Timing
  startedAt: {
    type: Date,
    default: Date.now
  },
  submittedAt: {
    type: Date
  },
  timeSpent: {
    type: Number, // in seconds
    default: 0
  },
  // Status
  status: {
    type: String,
    enum: ['in-progress', 'submitted', 'graded'],
    default: 'in-progress'
  }
}
```

**Indexes**:
- Compound index: `{ student: 1, module: 1, playlistItemId: 1 }` for quick lookups
- Index on `student` for student's quiz history

---

### 1.3 Certificate Model (New - Optional)

**Purpose**: Store certificate metadata and generation details.

**Schema**:
```javascript
{
  student: {
    type: ObjectId,
    ref: 'Student',
    required: true,
    index: true
  },
  module: {
    type: ObjectId,
    ref: 'TrainingModule',
    required: true,
    index: true
  },
  certificateId: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  // Certificate details
  studentName: {
    type: String,
    required: true
  },
  courseName: {
    type: String,
    required: true
  },
  completionDate: {
    type: Date,
    required: true
  },
  finalScore: {
    type: Number, // Average quiz score or overall score
    default: 0
  },
  // Certificate file/storage
  certificateUrl: {
    type: String, // URL to PDF/image certificate
    trim: true
  },
  certificateKey: {
    type: String, // Storage key if using file storage
    trim: true
  },
  // Verification
  verificationCode: {
    type: String, // Unique code for certificate verification
    unique: true,
    trim: true
  },
  issuedAt: {
    type: Date,
    default: Date.now
  }
}
```

**Indexes**:
- Unique index on `certificateId`
- Unique index on `verificationCode`
- Compound index: `{ student: 1, module: 1 }` (unique)

---

## 2. API Endpoints

### 2.1 Student Course Endpoints

**Base Path**: `/v1/training/students/:studentId/courses`

#### 2.1.1 Get Student's Courses
- **Method**: `GET`
- **URL**: `/v1/training/students/:studentId/courses`
- **Auth**: Required (`students.read` or student can view own)
- **Query Params**:
  - `status`: `'enrolled' | 'in-progress' | 'completed' | 'dropped'`
  - `moduleId`: Filter by specific module
  - `sortBy`: `'enrolledAt:desc' | 'progress.percentage:desc' | 'completedAt:desc'`
  - `limit`, `page`: Pagination
- **Logic**:
  1. Find all TrainingModules where `students` array contains `studentId`
  2. For each module, find/create StudentCourseProgress record
  3. Populate module details (name, description, coverImage, playlist)
  4. Combine with progress data (percentage, completedItems, quizScores)
- **Response**: List of courses with progress data
  ```json
  {
    "results": [
      {
        "module": {
          "id": "...",
          "moduleName": "JavaScript Fundamentals",
          "shortDescription": "...",
          "coverImage": {...},
          "playlist": [...],
          "categories": [...]
        },
        "progress": {
          "percentage": 65,
          "completedItems": [...],
          "quizScores": {...}
        },
        "enrolledAt": "...",
        "startedAt": "...",
        "status": "in-progress"
      }
    ]
  }
  ```

#### 2.1.2 Get Single Course Progress
- **Method**: `GET`
- **URL**: `/v1/training/students/:studentId/courses/:moduleId`
- **Auth**: Required
- **Logic**:
  1. Verify student is assigned to this module (check `TrainingModule.students` array)
  2. Get full TrainingModule details (populated with categories, playlist items)
  3. Get/create StudentCourseProgress for this student + module
  4. Mark which playlist items are completed in progress
  5. Include quiz attempt history for each quiz item
- **Response**: Detailed course progress including:
  - **Module details** (from TrainingModule): name, description, coverImage, full playlist
  - **Progress data**: percentage, completedItems, lastAccessedItem
  - **Quiz scores**: aggregated scores, individual quiz attempts
  - **Certificate status**: issued, certificateUrl, verificationCode

#### 2.1.3 Start Course
- **Method**: `POST`
- **URL**: `/v1/training/students/:studentId/courses/:moduleId/start`
- **Auth**: Required
- **Action**: Creates `StudentCourseProgress` if not exists, sets `startedAt`
- **Response**: Course progress object

#### 2.1.4 Mark Playlist Item as Complete
- **Method**: `POST`
- **URL**: `/v1/training/students/:studentId/courses/:moduleId/complete-item`
- **Auth**: Required
- **Body**:
  ```json
  {
    "playlistItemId": "0", // or index/unique ID
    "contentType": "upload-video"
  }
  ```
- **Action**: Adds item to `progress.completedItems`, recalculates percentage
- **Response**: Updated progress

#### 2.1.5 Update Last Accessed Item
- **Method**: `PATCH`
- **URL**: `/v1/training/students/:studentId/courses/:moduleId/last-accessed`
- **Auth**: Required
- **Body**:
  ```json
  {
    "playlistItemId": "0"
  }
  ```
- **Action**: Updates `progress.lastAccessedAt` and `lastAccessedItem`

---

### 2.2 Quiz Endpoints

**Base Path**: `/v1/training/students/:studentId/courses/:moduleId/quizzes`

#### 2.2.1 Get Quiz (Start Attempt)
- **Method**: `GET`
- **URL**: `/v1/training/students/:studentId/courses/:moduleId/quizzes/:playlistItemId`
- **Auth**: Required
- **Response**: Quiz questions (without correct answers marked for student view)

#### 2.2.2 Submit Quiz Attempt
- **Method**: `POST`
- **URL**: `/v1/training/students/:studentId/courses/:moduleId/quizzes/:playlistItemId/submit`
- **Auth**: Required
- **Body**:
  ```json
  {
    "answers": [
      {
        "questionIndex": 0,
        "selectedOptions": [0, 2] // Indices of selected options
      }
    ],
    "timeSpent": 300 // seconds
  }
  ```
- **Action**:
  - Creates `StudentQuizAttempt`
  - Calculates score (compares answers with correct answers)
  - Updates `StudentCourseProgress.quizScores`
  - If all quizzes completed and progress = 100%, triggers certificate generation
- **Response**: Quiz attempt with score

#### 2.2.3 Get Quiz Attempt History
- **Method**: `GET`
- **URL**: `/v1/training/students/:studentId/courses/:moduleId/quizzes/:playlistItemId/attempts`
- **Auth**: Required
- **Response**: List of all attempts for this quiz (with scores)

#### 2.2.4 Get Quiz Results (After Submission)
- **Method**: `GET`
- **URL**: `/v1/training/students/:studentId/courses/:moduleId/quizzes/:playlistItemId/results`
- **Auth**: Required
- **Response**: Latest attempt with correct answers shown

---

### 2.3 Certificate Endpoints

#### 2.3.1 Get Certificate
- **Method**: `GET`
- **URL**: `/v1/training/students/:studentId/courses/:moduleId/certificate`
- **Auth**: Required
- **Response**: Certificate details and download URL

#### 2.3.2 Generate Certificate (Auto-triggered)
- **Internal**: Triggered automatically when:
  - Course progress reaches 100%
  - All quizzes are completed
- **Action**: Creates certificate PDF/image, stores it, updates `StudentCourseProgress.certificate`

#### 2.3.3 Verify Certificate (Public)
- **Method**: `GET`
- **URL**: `/v1/public/certificates/verify/:verificationCode`
- **Auth**: Not required (public verification)
- **Response**: Certificate verification details

---

## 3. Business Logic & Calculations

### 3.1 Progress Percentage Calculation

**Formula**:
```
progressPercentage = (completedItems.length / totalPlaylistItems.length) * 100
```

**Rules**:
- Each playlist item counts equally (1 item = 1 unit)
- Item is "completed" when:
  - For videos/PDFs/blogs: Student marks as complete
  - For quizzes: Student submits attempt (regardless of score)
  - For tests: Student completes test

**Update Triggers**:
- When student marks item as complete
- When student submits quiz
- When student completes test

---

### 3.2 Quiz Scoring

**Calculation**:
```javascript
// For each question
if (question.allowMultipleAnswers) {
  // All correct options must be selected, no incorrect ones
  points = (selectedOptions match exactly with correctOptions) ? 1 : 0
} else {
  // Single answer: exact match
  points = (selectedOptions[0] === correctOptionIndex) ? 1 : 0
}

totalScore = sum(points) / totalQuestions * 100
```

**Scoring Rules**:
- Each question worth equal weight (1 point)
- Partial credit: Not supported initially (all-or-nothing)
- Retakes: Allowed, track `attemptNumber`, keep best score or latest score (configurable)

---

### 3.3 Certificate Generation Trigger

**Conditions** (all must be met):
1. `progress.percentage === 100`
2. All quiz items in playlist have at least one submitted attempt
3. `certificate.issued === false`

**Generation Process**:
1. Calculate final score (average of all quiz scores)
2. Generate certificate PDF/image with:
   - Student name
   - Course name (module name)
   - Completion date
   - Final score
   - Certificate ID
   - Verification code
3. Store certificate (file storage or database)
4. Update `StudentCourseProgress.certificate` fields
5. Create `Certificate` record
6. Update `status` to `'completed'`

---

## 4. Implementation Steps

### Phase 1: Models & Basic Progress Tracking
1. Create `StudentCourseProgress` model
2. Create service: `studentCourseProgress.service.js`
   - **Key function**: `getStudentCourses(studentId)` 
     - Query: `TrainingModule.find({ students: studentId })`
     - For each module, get/create `StudentCourseProgress`
     - Populate module details, combine with progress
3. Create controller: `studentCourse.controller.js`
4. Create routes: `/v1/training/students/:studentId/courses`
5. Implement:
   - Get student's courses (from modules where student is assigned)
   - Start course (creates StudentCourseProgress, sets startedAt)
   - Mark item complete (updates progress.completedItems, recalculates %)
   - Calculate progress percentage (completedItems.length / playlist.length * 100)

### Phase 2: Quiz System
1. Create `StudentQuizAttempt` model
2. Create service: `studentQuiz.service.js`
3. Add quiz endpoints to routes
4. Implement:
   - Get quiz (sanitized for student)
   - Submit quiz (calculate score)
   - Get quiz history/results

### Phase 3: Certificate System
1. Create `Certificate` model
2. Create service: `certificate.service.js`
3. Implement certificate generation (PDF/image)
4. Add certificate endpoints
5. Auto-trigger on 100% completion

### Phase 4: Integration & Testing
1. Integrate with existing Training Module system
2. Add activity logging
3. Add validations
4. Write tests
5. Update frontend documentation

---

## 5. Database Relationships

```
Student (1) ──< (many) StudentCourseProgress (many) >── (1) TrainingModule
                                                              │
                                                              │ (has)
                                                              ▼
                                                         Playlist Items
                                                              │
                                                              │ (includes)
                                                              ▼
Student (1) ──< (many) StudentQuizAttempt (many) >── (1) Quiz Item
                                                              │
                                                              │ (belongs to)
                                                              ▼
                                                         TrainingModule

Student (1) ──< (many) Certificate (many) >── (1) TrainingModule
```

---

## 6. Permissions

- **`students.courses.read`**: View own courses
- **`students.courses.manage`**: Admin can view/manage any student's courses
- **`students.quizzes.take`**: Take quizzes
- **`certificates.view`**: View certificates
- **`certificates.verify`**: Public verification (no auth)

---

## 7. Frontend Integration Points

### Student Dashboard
- List of enrolled courses with progress bars
- "Continue Learning" button (resume from last accessed item)

### Course Player Page
- Playlist sidebar with completion indicators
- Content viewer (video/PDF/blog)
- "Mark as Complete" button
- Quiz interface
- Progress bar at top

### Certificate Page
- Certificate display/download
- Verification code
- Share certificate link

---

## 8. Future Enhancements (Out of Scope)

- Course ratings/reviews
- Discussion forums per course
- Course prerequisites
- Badges/achievements
- Course analytics (time spent, drop-off points)
- Certificate templates customization
- Email notifications on completion

---

## 9. Files to Create/Modify

### New Files:
- `src/models/studentCourseProgress.model.js`
- `src/models/studentQuizAttempt.model.js`
- `src/models/certificate.model.js`
- `src/services/studentCourse.service.js`
- `src/services/studentQuiz.service.js`
- `src/services/certificate.service.js`
- `src/controllers/studentCourse.controller.js`
- `src/controllers/studentQuiz.controller.js`
- `src/validations/studentCourse.validation.js`
- `src/validations/studentQuiz.validation.js`
- `src/routes/v1/studentCourse.route.js`

### Modified Files:
- `src/routes/v1/index.js` (add student course routes)
- `src/config/permissions.js` (add new permissions)
- `src/config/activityLog.js` (add activity actions)

---

## 10. Questions to Clarify

1. **Certificate Format**: PDF, image (PNG/JPG), or both?
2. **Certificate Storage**: Database (base64), file system, or cloud storage?
3. **Quiz Retakes**: Unlimited or limited attempts?
4. **Quiz Passing Score**: Is there a minimum score required to "pass" a quiz?
5. **Course Prerequisites**: Should students complete prerequisites before accessing a course?
6. **Auto-enrollment**: Should students be auto-enrolled when assigned to a module, or manually start?
7. **Certificate Template**: Customizable template or fixed design?

---

This plan provides a comprehensive foundation for implementing the Student Courses system. Once approved, we can proceed with implementation phase by phase.
