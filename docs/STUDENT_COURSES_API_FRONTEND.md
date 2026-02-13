# Student Courses API - Frontend Implementation Guide

This document provides comprehensive API documentation for implementing the Student Courses feature in the frontend application.

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [API Endpoints](#api-endpoints)
4. [Data Models](#data-models)
5. [Error Handling](#error-handling)
6. [Frontend Implementation Steps](#frontend-implementation-steps)
7. [Example Workflows](#example-workflows)

---

## Overview

The Student Courses API allows students to:
- View courses assigned to them (from Training Modules)
- Track progress through course content
- Take quizzes and view results
- Receive certificates upon course completion

**Base URL**: `https://uat-dharwin-backend.onrender.com/v1` (production) or `http://localhost:3000/v1` (development)

**Key Concepts**:
- **Course** = **Training Module** (they are the same entity)
- Courses are assigned to students via the `TrainingModule.students` array
- Progress is tracked in `StudentCourseProgress` model
- Quizzes are part of the course playlist
- Certificates are auto-generated when course reaches 100% completion

---

## Authentication

All endpoints require authentication using JWT tokens. Include the token in the `Authorization` header:

```javascript
headers: {
  'Authorization': `Bearer ${accessToken}`,
  'Content-Type': 'application/json'
}
```

Or use cookies (if using cookie-based auth):
```javascript
fetch(url, {
  credentials: 'include', // Important for cookies
  headers: {
    'Content-Type': 'application/json'
  }
})
```

**Required Permissions**:
- `students.courses.read` - View courses and progress
- `students.courses.manage` - Start courses, mark items complete
- `students.quizzes.take` - Take quizzes

---

## API Endpoints

### 1. Get Student's Courses

Get a list of all courses assigned to a student.

**Endpoint**: `GET /training/students/:studentId/courses`

**Headers**:
```
Authorization: Bearer <token>
```

**Query Parameters**:
- `status` (optional): Filter by status (`enrolled`, `in-progress`, `completed`, `dropped`)
- `sortBy` (optional): Sort order (e.g., `enrolledAt:desc`, `progress.percentage:desc`)
- `limit` (optional): Number of results per page (default: 10)
- `page` (optional): Page number (default: 1)

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/training/students/${studentId}/courses?status=in-progress&limit=10&page=1`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include'
  }
);
const data = await response.json();
```

**Response** (200 OK):
```json
{
  "results": [
    {
      "module": {
        "id": "65a1b2c3d4e5f6789012345a",
        "moduleName": "JavaScript Fundamentals",
        "shortDescription": "Learn the basics of JavaScript programming",
        "coverImage": {
          "key": "cover-images/...",
          "url": "https://...",
          "originalName": "js-fundamentals.jpg"
        },
        "categories": [
          {
            "id": "...",
            "name": "Programming",
            "description": "..."
          }
        ],
        "playlist": [
          {
            "contentType": "youtube-link",
            "title": "Introduction to JavaScript",
            "duration": 15,
            "youtubeLink": "https://youtube.com/watch?v=..."
          },
          {
            "contentType": "quiz",
            "title": "JavaScript Basics Quiz",
            "duration": 10,
            "quiz": {
              "questions": [...]
            }
          }
        ],
        "status": "active",
        "createdAt": "2024-01-15T10:00:00.000Z",
        "updatedAt": "2024-01-15T10:00:00.000Z"
      },
      "progress": {
        "percentage": 65,
        "completedItems": [
          {
            "playlistItemId": "0",
            "completedAt": "2024-01-20T14:30:00.000Z",
            "contentType": "youtube-link"
          },
          {
            "playlistItemId": "1",
            "completedAt": "2024-01-20T15:00:00.000Z",
            "contentType": "quiz"
          }
        ],
        "lastAccessedAt": "2024-01-20T15:00:00.000Z",
        "lastAccessedItem": {
          "playlistItemId": "1"
        }
      },
      "quizScores": {
        "totalQuizzes": 3,
        "completedQuizzes": 1,
        "averageScore": 85,
        "totalScore": 85
      },
      "enrolledAt": "2024-01-15T10:00:00.000Z",
      "startedAt": "2024-01-20T14:00:00.000Z",
      "completedAt": null,
      "status": "in-progress",
      "certificate": {
        "issued": false,
        "issuedAt": null,
        "certificateId": null,
        "certificateUrl": null
      }
    }
  ],
  "page": 1,
  "limit": 10,
  "totalPages": 1,
  "totalResults": 1
}
```

---

### 2. Get Single Course with Full Details

Get detailed information about a specific course including all playlist items with progress indicators.

**Endpoint**: `GET /training/students/:studentId/courses/:moduleId`

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/training/students/${studentId}/courses/${moduleId}`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include'
  }
);
const course = await response.json();
```

**Response** (200 OK):
```json
{
  "module": {
    "id": "65a1b2c3d4e5f6789012345a",
    "moduleName": "JavaScript Fundamentals",
    "shortDescription": "Learn the basics of JavaScript programming",
    "coverImage": {
      "key": "cover-images/...",
      "url": "https://...",
      "originalName": "js-fundamentals.jpg"
    },
    "categories": [...],
    "playlist": [
      {
        "contentType": "youtube-link",
        "title": "Introduction to JavaScript",
        "duration": 15,
        "youtubeLink": "https://youtube.com/watch?v=...",
        "playlistItemId": "0",
        "isCompleted": true,
        "quizAttempts": null
      },
      {
        "contentType": "quiz",
        "title": "JavaScript Basics Quiz",
        "duration": 10,
        "quiz": {
          "questions": [
            {
              "questionText": "What is JavaScript?",
              "allowMultipleAnswers": false,
              "options": [
                { "text": "A programming language" },
                { "text": "A coffee brand" }
              ]
            }
          ]
        },
        "playlistItemId": "1",
        "isCompleted": true,
        "quizAttempts": [
          {
            "id": "...",
            "attemptNumber": 1,
            "score": {
              "percentage": 85,
              "correctAnswers": 17,
              "totalQuestions": 20
            },
            "submittedAt": "2024-01-20T15:00:00.000Z"
          }
        ]
      }
    ],
    "status": "active"
  },
  "progress": {
    "percentage": 65,
    "completedItems": [...],
    "lastAccessedAt": "2024-01-20T15:00:00.000Z",
    "lastAccessedItem": {
      "playlistItemId": "1"
    }
  },
  "quizScores": {
    "totalQuizzes": 3,
    "completedQuizzes": 1,
    "averageScore": 85,
    "totalScore": 85
  },
  "enrolledAt": "2024-01-15T10:00:00.000Z",
  "startedAt": "2024-01-20T14:00:00.000Z",
  "completedAt": null,
  "status": "in-progress",
  "certificate": {
    "issued": false,
    "issuedAt": null,
    "certificateId": null,
    "certificateUrl": null
  }
}
```

---

### 3. Start Course

Mark a course as started (sets `startedAt` timestamp).

**Endpoint**: `POST /training/students/:studentId/courses/:moduleId/start`

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/training/students/${studentId}/courses/${moduleId}/start`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include'
  }
);
const progress = await response.json();
```

**Response** (200 OK):
```json
{
  "id": "...",
  "student": "...",
  "module": "...",
  "enrolledAt": "2024-01-15T10:00:00.000Z",
  "startedAt": "2024-01-20T14:00:00.000Z",
  "status": "in-progress",
  "progress": {
    "percentage": 0,
    "completedItems": [],
    "lastAccessedAt": "2024-01-20T14:00:00.000Z"
  }
}
```

---

### 4. Mark Playlist Item as Complete

Mark a playlist item (video, PDF, blog, etc.) as completed.

**Endpoint**: `POST /training/students/:studentId/courses/:moduleId/complete-item`

**Request Body**:
```json
{
  "playlistItemId": "0",
  "contentType": "youtube-link"
}
```

**Content Types**:
- `upload-video`
- `youtube-link`
- `pdf-document`
- `blog`
- `quiz`
- `test`

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/training/students/${studentId}/courses/${moduleId}/complete-item`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      playlistItemId: '0',
      contentType: 'youtube-link'
    })
  }
);
const progress = await response.json();
```

**Response** (200 OK):
```json
{
  "id": "...",
  "progress": {
    "percentage": 25,
    "completedItems": [
      {
        "playlistItemId": "0",
        "completedAt": "2024-01-20T14:30:00.000Z",
        "contentType": "youtube-link"
      }
    ],
    "lastAccessedAt": "2024-01-20T14:30:00.000Z",
    "lastAccessedItem": {
      "playlistItemId": "0"
    }
  },
  "status": "in-progress"
}
```

**Note**: Progress percentage is automatically recalculated. If it reaches 100%, the course status changes to `completed` and a certificate is auto-generated.

---

### 5. Update Last Accessed Item

Update the last accessed playlist item (useful for resuming course).

**Endpoint**: `PATCH /training/students/:studentId/courses/:moduleId/last-accessed`

**Request Body**:
```json
{
  "playlistItemId": "2"
}
```

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/training/students/${studentId}/courses/${moduleId}/last-accessed`,
  {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      playlistItemId: '2'
    })
  }
);
const progress = await response.json();
```

---

### 6. Get Quiz (Sanitized)

Get a quiz without correct answers (for taking the quiz).

**Endpoint**: `GET /training/students/:studentId/courses/:moduleId/quizzes/:playlistItemId`

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/training/students/${studentId}/courses/${moduleId}/quizzes/${playlistItemId}`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include'
  }
);
const quiz = await response.json();
```

**Response** (200 OK):
```json
{
  "playlistItemId": "1",
  "title": "JavaScript Basics Quiz",
  "duration": 10,
  "questions": [
    {
      "questionText": "What is JavaScript?",
      "allowMultipleAnswers": false,
      "options": [
        { "text": "A programming language" },
        { "text": "A coffee brand" },
        { "text": "A web browser" },
        { "text": "A database" }
      ]
    },
    {
      "questionText": "Which of the following are JavaScript data types?",
      "allowMultipleAnswers": true,
      "options": [
        { "text": "String" },
        { "text": "Number" },
        { "text": "Boolean" },
        { "text": "Array" }
      ]
    }
  ]
}
```

**Note**: The `isCorrect` field is NOT included in the options - this is intentional for security.

---

### 7. Submit Quiz Attempt

Submit answers for a quiz attempt.

**Endpoint**: `POST /training/students/:studentId/courses/:moduleId/quizzes/:playlistItemId/submit`

**Request Body**:
```json
{
  "answers": [
    {
      "questionIndex": 0,
      "selectedOptions": [0]
    },
    {
      "questionIndex": 1,
      "selectedOptions": [0, 1, 2]
    }
  ],
  "timeSpent": 300
}
```

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/training/students/${studentId}/courses/${moduleId}/quizzes/${playlistItemId}/submit`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      answers: [
        {
          questionIndex: 0,
          selectedOptions: [0] // Selected option at index 0
        },
        {
          questionIndex: 1,
          selectedOptions: [0, 1, 2] // Multiple selections for multi-answer question
        }
      ],
      timeSpent: 300 // Time in seconds
    })
  }
);
const attempt = await response.json();
```

**Response** (200 OK):
```json
{
  "id": "...",
  "student": "...",
  "module": "...",
  "playlistItemId": "1",
  "attemptNumber": 1,
  "answers": [
    {
      "questionIndex": 0,
      "selectedOptions": [0],
      "isCorrect": true,
      "pointsEarned": 1
    },
    {
      "questionIndex": 1,
      "selectedOptions": [0, 1, 2],
      "isCorrect": true,
      "pointsEarned": 1
    }
  ],
  "score": {
    "totalQuestions": 2,
    "correctAnswers": 2,
    "percentage": 100,
    "totalPoints": 2,
    "maxPoints": 2
  },
  "timeSpent": 300,
  "submittedAt": "2024-01-20T15:00:00.000Z",
  "status": "graded"
}
```

**Note**: 
- The quiz item is automatically marked as completed
- Course progress percentage is recalculated
- Quiz scores are updated in course progress
- If course reaches 100%, certificate is auto-generated

---

### 8. Get Quiz Attempt History

Get all attempts for a specific quiz.

**Endpoint**: `GET /training/students/:studentId/courses/:moduleId/quizzes/:playlistItemId/attempts`

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/training/students/${studentId}/courses/${moduleId}/quizzes/${playlistItemId}/attempts`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include'
  }
);
const attempts = await response.json();
```

**Response** (200 OK):
```json
[
  {
    "id": "...",
    "attemptNumber": 2,
    "score": {
      "percentage": 100,
      "correctAnswers": 20,
      "totalQuestions": 20
    },
    "submittedAt": "2024-01-20T16:00:00.000Z",
    "timeSpent": 450
  },
  {
    "id": "...",
    "attemptNumber": 1,
    "score": {
      "percentage": 85,
      "correctAnswers": 17,
      "totalQuestions": 20
    },
    "submittedAt": "2024-01-20T15:00:00.000Z",
    "timeSpent": 600
  }
]
```

---

### 9. Get Quiz Results

Get quiz results with correct answers shown (for review after submission).

**Endpoint**: `GET /training/students/:studentId/courses/:moduleId/quizzes/:playlistItemId/results`

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/training/students/${studentId}/courses/${moduleId}/quizzes/${playlistItemId}/results`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include'
  }
);
const results = await response.json();
```

**Response** (200 OK):
```json
{
  "quiz": {
    "playlistItemId": "1",
    "title": "JavaScript Basics Quiz",
    "questions": [
      {
        "questionText": "What is JavaScript?",
        "allowMultipleAnswers": false,
        "options": [
          {
            "text": "A programming language",
            "isCorrect": true,
            "isSelected": true
          },
          {
            "text": "A coffee brand",
            "isCorrect": false,
            "isSelected": false
          }
        ],
        "studentAnswer": [0],
        "isCorrect": true
      }
    ]
  },
  "attempt": {
    "attemptNumber": 1,
    "score": {
      "percentage": 100,
      "correctAnswers": 20,
      "totalQuestions": 20
    },
    "submittedAt": "2024-01-20T15:00:00.000Z",
    "timeSpent": 300
  }
}
```

---

### 10. Get Certificate

Get certificate for a completed course.

**Endpoint**: `GET /training/students/:studentId/courses/:moduleId/certificate`

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/training/students/${studentId}/courses/${moduleId}/certificate`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include'
  }
);
const certificate = await response.json();
```

**Response** (200 OK):
```json
{
  "id": "...",
  "certificateId": "CERT-1737388800000-a1b2c3d4",
  "studentName": "John Doe",
  "courseName": "JavaScript Fundamentals",
  "completionDate": "2024-01-20T16:00:00.000Z",
  "finalScore": 92,
  "certificateUrl": "https://...",
  "verificationCode": "A1B2C3D4",
  "issuedAt": "2024-01-20T16:00:00.000Z"
}
```

---

### 11. Generate Certificate (Manual)

Manually trigger certificate generation (usually auto-generated, but can be triggered manually).

**Endpoint**: `POST /training/students/:studentId/courses/:moduleId/certificate`

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/training/students/${studentId}/courses/${moduleId}/certificate`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include'
  }
);
const certificate = await response.json();
```

**Response** (200 OK): Same as GET certificate endpoint.

**Error** (400 Bad Request): If course is not 100% complete:
```json
{
  "code": 400,
  "message": "Course is not 100% complete"
}
```

---

### 12. Verify Certificate (Public)

Verify a certificate using its verification code (public endpoint, no auth required).

**Endpoint**: `GET /certificates/verify/:verificationCode`

**Example Request**:
```javascript
const response = await fetch(
  `${API_BASE_URL}/certificates/verify/A1B2C3D4`,
  {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    }
  }
);
const result = await response.json();
```

**Response** (200 OK):
```json
{
  "valid": true,
  "certificate": {
    "certificateId": "CERT-1737388800000-a1b2c3d4",
    "studentName": "John Doe",
    "courseName": "JavaScript Fundamentals",
    "completionDate": "2024-01-20T16:00:00.000Z",
    "finalScore": 92,
    "issuedAt": "2024-01-20T16:00:00.000Z"
  }
}
```

**Response** (404 Not Found): Invalid verification code:
```json
{
  "code": 404,
  "message": "Certificate not found or invalid verification code"
}
```

---

## Data Models

### Course Progress Object
```typescript
interface CourseProgress {
  percentage: number; // 0-100
  completedItems: Array<{
    playlistItemId: string;
    completedAt: Date;
    contentType: string;
  }>;
  lastAccessedAt: Date;
  lastAccessedItem: {
    playlistItemId: string;
  };
}
```

### Quiz Score Object
```typescript
interface QuizScores {
  totalQuizzes: number;
  completedQuizzes: number;
  averageScore: number; // 0-100
  totalScore: number;
}
```

### Certificate Object
```typescript
interface Certificate {
  issued: boolean;
  issuedAt: Date | null;
  certificateId: string | null;
  certificateUrl: string | null;
}
```

---

## Error Handling

All endpoints return standard error responses:

**400 Bad Request**:
```json
{
  "code": 400,
  "message": "playlistItemId and contentType are required"
}
```

**401 Unauthorized**:
```json
{
  "code": 401,
  "message": "Please authenticate"
}
```

**403 Forbidden**:
```json
{
  "code": 403,
  "message": "Student is not assigned to this module"
}
```

**404 Not Found**:
```json
{
  "code": 404,
  "message": "Training module not found"
}
```

**500 Internal Server Error**:
```json
{
  "code": 500,
  "message": "Internal server error"
}
```

---

## Frontend Implementation Steps

### Step 1: Setup API Client

Create an API client utility:

```javascript
// utils/api.js
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/v1';

export const apiClient = async (endpoint, options = {}) => {
  const token = localStorage.getItem('accessToken'); // or from your auth context
  
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'API request failed');
  }

  return response.json();
};
```

### Step 2: Create Course Service

```javascript
// services/courseService.js
import { apiClient } from '../utils/api';

export const courseService = {
  // Get all courses for a student
  getCourses: (studentId, filters = {}) => {
    const params = new URLSearchParams(filters);
    return apiClient(`/training/students/${studentId}/courses?${params}`);
  },

  // Get single course with details
  getCourse: (studentId, moduleId) => {
    return apiClient(`/training/students/${studentId}/courses/${moduleId}`);
  },

  // Start course
  startCourse: (studentId, moduleId) => {
    return apiClient(`/training/students/${studentId}/courses/${moduleId}/start`, {
      method: 'POST',
    });
  },

  // Mark item complete
  markItemComplete: (studentId, moduleId, playlistItemId, contentType) => {
    return apiClient(`/training/students/${studentId}/courses/${moduleId}/complete-item`, {
      method: 'POST',
      body: JSON.stringify({ playlistItemId, contentType }),
    });
  },

  // Update last accessed
  updateLastAccessed: (studentId, moduleId, playlistItemId) => {
    return apiClient(`/training/students/${studentId}/courses/${moduleId}/last-accessed`, {
      method: 'PATCH',
      body: JSON.stringify({ playlistItemId }),
    });
  },

  // Get certificate
  getCertificate: (studentId, moduleId) => {
    return apiClient(`/training/students/${studentId}/courses/${moduleId}/certificate`);
  },
};
```

### Step 3: Create Quiz Service

```javascript
// services/quizService.js
import { apiClient } from '../utils/api';

export const quizService = {
  // Get quiz (sanitized)
  getQuiz: (studentId, moduleId, playlistItemId) => {
    return apiClient(`/training/students/${studentId}/courses/${moduleId}/quizzes/${playlistItemId}`);
  },

  // Submit quiz attempt
  submitQuiz: (studentId, moduleId, playlistItemId, answers, timeSpent) => {
    return apiClient(`/training/students/${studentId}/courses/${moduleId}/quizzes/${playlistItemId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers, timeSpent }),
    });
  },

  // Get quiz results
  getQuizResults: (studentId, moduleId, playlistItemId) => {
    return apiClient(`/training/students/${studentId}/courses/${moduleId}/quizzes/${playlistItemId}/results`);
  },

  // Get attempt history
  getAttemptHistory: (studentId, moduleId, playlistItemId) => {
    return apiClient(`/training/students/${studentId}/courses/${moduleId}/quizzes/${playlistItemId}/attempts`);
  },
};
```

### Step 4: Course List Component

```javascript
// components/CourseList.jsx
import { useState, useEffect } from 'react';
import { courseService } from '../services/courseService';

export const CourseList = ({ studentId }) => {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadCourses();
  }, [studentId]);

  const loadCourses = async () => {
    try {
      const data = await courseService.getCourses(studentId, { status: 'in-progress' });
      setCourses(data.results);
    } catch (error) {
      console.error('Failed to load courses:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div className="course-list">
      {courses.map((course) => (
        <div key={course.module.id} className="course-card">
          <img src={course.module.coverImage?.url} alt={course.module.moduleName} />
          <h3>{course.module.moduleName}</h3>
          <p>{course.module.shortDescription}</p>
          <div className="progress-bar">
            <div 
              className="progress-fill" 
              style={{ width: `${course.progress.percentage}%` }}
            />
          </div>
          <p>{course.progress.percentage}% Complete</p>
          {course.certificate.issued && (
            <a href={course.certificate.certificateUrl}>View Certificate</a>
          )}
        </div>
      ))}
    </div>
  );
};
```

### Step 5: Course Player Component

```javascript
// components/CoursePlayer.jsx
import { useState, useEffect } from 'react';
import { courseService } from '../services/courseService';

export const CoursePlayer = ({ studentId, moduleId }) => {
  const [course, setCourse] = useState(null);
  const [currentItemIndex, setCurrentItemIndex] = useState(0);

  useEffect(() => {
    loadCourse();
  }, [studentId, moduleId]);

  const loadCourse = async () => {
    try {
      const data = await courseService.getCourse(studentId, moduleId);
      setCourse(data);
      
      // Resume from last accessed item
      if (data.progress.lastAccessedItem?.playlistItemId) {
        const lastIndex = parseInt(data.progress.lastAccessedItem.playlistItemId);
        setCurrentItemIndex(lastIndex);
      }
    } catch (error) {
      console.error('Failed to load course:', error);
    }
  };

  const handleItemComplete = async (playlistItemId, contentType) => {
    try {
      await courseService.markItemComplete(studentId, moduleId, playlistItemId, contentType);
      await loadCourse(); // Reload to get updated progress
    } catch (error) {
      console.error('Failed to mark item complete:', error);
    }
  };

  const handleItemView = async (playlistItemId) => {
    try {
      await courseService.updateLastAccessed(studentId, moduleId, playlistItemId);
    } catch (error) {
      console.error('Failed to update last accessed:', error);
    }
  };

  if (!course) return <div>Loading...</div>;

  const currentItem = course.module.playlist[currentItemIndex];

  return (
    <div className="course-player">
      <div className="playlist-sidebar">
        {course.module.playlist.map((item, index) => (
          <div
            key={index}
            className={`playlist-item ${item.isCompleted ? 'completed' : ''} ${index === currentItemIndex ? 'active' : ''}`}
            onClick={() => {
              setCurrentItemIndex(index);
              handleItemView(index.toString());
            }}
          >
            {item.isCompleted && <span>✓</span>}
            {item.title}
          </div>
        ))}
      </div>
      
      <div className="content-area">
        {currentItem.contentType === 'youtube-link' && (
          <YouTubePlayer 
            url={currentItem.youtubeLink}
            onComplete={() => handleItemComplete(currentItemIndex.toString(), 'youtube-link')}
          />
        )}
        {currentItem.contentType === 'quiz' && (
          <QuizComponent
            studentId={studentId}
            moduleId={moduleId}
            playlistItemId={currentItemIndex.toString()}
            quiz={currentItem.quiz}
            onComplete={() => handleItemComplete(currentItemIndex.toString(), 'quiz')}
          />
        )}
      </div>
    </div>
  );
};
```

### Step 6: Quiz Component

```javascript
// components/QuizComponent.jsx
import { useState, useEffect } from 'react';
import { quizService } from '../services/quizService';

export const QuizComponent = ({ studentId, moduleId, playlistItemId, onComplete }) => {
  const [quiz, setQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [results, setResults] = useState(null);
  const [startTime] = useState(Date.now());

  useEffect(() => {
    loadQuiz();
  }, [playlistItemId]);

  const loadQuiz = async () => {
    try {
      const data = await quizService.getQuiz(studentId, moduleId, playlistItemId);
      setQuiz(data);
    } catch (error) {
      console.error('Failed to load quiz:', error);
    }
  };

  const handleOptionSelect = (questionIndex, optionIndex, allowMultiple) => {
    setAnswers((prev) => {
      const current = prev[questionIndex] || [];
      if (allowMultiple) {
        const newAnswers = current.includes(optionIndex)
          ? current.filter((i) => i !== optionIndex)
          : [...current, optionIndex];
        return { ...prev, [questionIndex]: newAnswers };
      } else {
        return { ...prev, [questionIndex]: [optionIndex] };
      }
    });
  };

  const handleSubmit = async () => {
    const timeSpent = Math.floor((Date.now() - startTime) / 1000);
    const answersArray = Object.entries(answers).map(([questionIndex, selectedOptions]) => ({
      questionIndex: parseInt(questionIndex),
      selectedOptions,
    }));

    try {
      const attempt = await quizService.submitQuiz(studentId, moduleId, playlistItemId, answersArray, timeSpent);
      setSubmitted(true);
      
      // Load results to show correct answers
      const resultsData = await quizService.getQuizResults(studentId, moduleId, playlistItemId);
      setResults(resultsData);
      
      onComplete();
    } catch (error) {
      console.error('Failed to submit quiz:', error);
    }
  };

  if (!quiz) return <div>Loading quiz...</div>;

  return (
    <div className="quiz-component">
      <h2>{quiz.title}</h2>
      
      {quiz.questions.map((question, qIndex) => (
        <div key={qIndex} className="question">
          <h3>{question.questionText}</h3>
          {question.allowMultipleAnswers && <p>(Select all that apply)</p>}
          
          {question.options.map((option, oIndex) => {
            const isSelected = answers[qIndex]?.includes(oIndex);
            const isCorrect = results?.quiz.questions[qIndex]?.options[oIndex]?.isCorrect;
            const wasSelected = results?.quiz.questions[qIndex]?.options[oIndex]?.isSelected;
            
            return (
              <label
                key={oIndex}
                className={`option ${submitted ? (isCorrect ? 'correct' : wasSelected ? 'incorrect' : '') : ''} ${isSelected ? 'selected' : ''}`}
              >
                <input
                  type={question.allowMultipleAnswers ? 'checkbox' : 'radio'}
                  checked={isSelected}
                  onChange={() => handleOptionSelect(qIndex, oIndex, question.allowMultipleAnswers)}
                  disabled={submitted}
                />
                {option.text}
                {submitted && isCorrect && <span>✓</span>}
                {submitted && !isCorrect && wasSelected && <span>✗</span>}
              </label>
            );
          })}
        </div>
      ))}
      
      {!submitted && (
        <button onClick={handleSubmit}>Submit Quiz</button>
      )}
      
      {submitted && results && (
        <div className="quiz-results">
          <h3>Results</h3>
          <p>Score: {results.attempt.score.percentage}%</p>
          <p>Correct: {results.attempt.score.correctAnswers} / {results.attempt.score.totalQuestions}</p>
        </div>
      )}
    </div>
  );
};
```

---

## Example Workflows

### Workflow 1: Student Views Course List

1. Student navigates to "My Courses" page
2. Frontend calls `GET /training/students/:studentId/courses`
3. Display courses with progress bars
4. Student clicks on a course
5. Frontend calls `GET /training/students/:studentId/courses/:moduleId`
6. Display course details with playlist

### Workflow 2: Student Completes a Video

1. Student watches YouTube video
2. Video ends or student clicks "Mark as Complete"
3. Frontend calls `POST /training/students/:studentId/courses/:moduleId/complete-item`
4. Progress percentage updates automatically
5. If 100% complete, certificate is auto-generated

### Workflow 3: Student Takes a Quiz

1. Student clicks on quiz item in playlist
2. Frontend calls `GET /training/students/:studentId/courses/:moduleId/quizzes/:playlistItemId`
3. Display quiz questions (without correct answers)
4. Student selects answers and clicks "Submit"
5. Frontend calls `POST /training/students/:studentId/courses/:moduleId/quizzes/:playlistItemId/submit`
6. Quiz is automatically marked as completed
7. Frontend calls `GET /training/students/:studentId/courses/:moduleId/quizzes/:playlistItemId/results`
8. Display results with correct answers highlighted

### Workflow 4: Certificate Generation

1. Student completes all course items (reaches 100%)
2. Certificate is automatically generated
3. Frontend polls or checks `GET /training/students/:studentId/courses/:moduleId`
4. When `certificate.issued === true`, display certificate download link
5. Student can share certificate using verification code

---

## Best Practices

1. **Progress Tracking**: Always update `lastAccessed` when student views an item
2. **Error Handling**: Show user-friendly error messages
3. **Loading States**: Display loading indicators during API calls
4. **Optimistic Updates**: Update UI immediately, then sync with server
5. **Caching**: Cache course data to reduce API calls
6. **Resume Functionality**: Use `lastAccessedItem` to resume from where student left off
7. **Certificate Display**: Show certificate badge/icon when `certificate.issued === true`

---

## Testing Checklist

- [ ] List courses for a student
- [ ] View single course details
- [ ] Start a course
- [ ] Mark video/PDF/blog items as complete
- [ ] Progress percentage updates correctly
- [ ] Take a quiz (single and multiple answer questions)
- [ ] Submit quiz and view results
- [ ] Certificate auto-generates at 100% completion
- [ ] View certificate details
- [ ] Verify certificate with verification code
- [ ] Handle errors gracefully
- [ ] Resume course from last accessed item

---

## Support

For questions or issues, contact the backend team or refer to the API documentation.

**Last Updated**: February 2026
