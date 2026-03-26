## Training Modules API – Frontend Guide (Single Schema, Inline Quiz)

This document reflects the **latest backend contract**:

- Quiz questions are stored **inside the training module schema**.
- There is **no separate quiz API**.
- All module + playlist + quiz data is managed via `/v1/training/modules` only.

Base URL (dev): `http://localhost:3000`

All endpoints require:

- `Authorization: Bearer <accessToken>`
- Permissions:
  - Read: `modules.read`
  - Create/Update/Delete: `modules.manage`

---

### 1) Endpoints

All under `/v1/training/modules`:

- **List**: `GET /v1/training/modules?search=&category=&status=&page=1&limit=20&sortBy=moduleName:asc`
- **Get one**: `GET /v1/training/modules/:moduleId`
- **Create**: `POST /v1/training/modules` (`multipart/form-data`)
- **Update**: `PATCH /v1/training/modules/:moduleId` (`multipart/form-data`)
- **Delete**: `DELETE /v1/training/modules/:moduleId`

---

### 2) Response model (complete data)

```jsonc
{
  "id": "698c7ae95d1992fafc934c2a",
  "moduleName": "Second Module",
  "shortDescription": "Desc",
  "status": "draft",
  "coverImage": {
    "key": "training-module-cover-images/<userId>/<timestamp>-<random>.png",
    "url": "https://...presigned-url...",
    "originalName": "s.png",
    "size": 230356,
    "mimeType": "image/png",
    "uploadedAt": "2026-02-11T12:49:45.510Z"
  },
  "categories": [
    {
      "id": "698c76e05d1992fafc934a26",
      "name": "Technical Skills"
    }
  ],
  "students": [
    {
      "id": "698c357f59fd1a62294af123",
      "phone": "9876543210",
      "user": {
        "id": "698c357f59fd1a62294af121",
        "name": "Student One",
        "email": "student1@example.com",
        "status": "active",
        "isEmailVerified": true
      }
    }
  ],
  "mentorsAssigned": [
    {
      "id": "698c6ae0cdbb6dc98705e413",
      "phone": "9879879879",
      "user": {
        "id": "698c6adfcdbb6dc98705e411",
        "name": "Mentor One",
        "email": "mentor1@example.com",
        "status": "active",
        "isEmailVerified": true
      }
    }
  ],
  "playlist": [
    {
      "_id": "playlist-item-1",
      "contentType": "upload-video",
      "title": "Lesson 1 – Intro",
      "duration": 15,
      "order": 0,
      "videoFile": {
        "key": "training-module-videos/<userId>/...",
        "url": "https://...presigned-url...",
        "originalName": "intro.mp4",
        "size": 123456789,
        "mimeType": "video/mp4",
        "uploadedAt": "2026-02-11T12:50:00.000Z"
      }
    },
    {
      "_id": "playlist-item-2",
      "contentType": "pdf-document",
      "title": "Slides",
      "duration": 5,
      "order": 1,
      "pdfDocument": {
        "key": "training-module-pdfs/<userId>/...",
        "url": "https://...presigned-url...",
        "originalName": "slides.pdf",
        "size": 234567,
        "mimeType": "application/pdf",
        "uploadedAt": "2026-02-11T12:51:00.000Z"
      }
    },
    {
      "_id": "playlist-item-3",
      "contentType": "youtube-link",
      "title": "External Video",
      "duration": 10,
      "order": 2,
      "youtubeUrl": "https://www.youtube.com/watch?v=abcd1234"
    },
    {
      "_id": "playlist-item-4",
      "contentType": "blog",
      "title": "Article",
      "duration": 10,
      "order": 3,
      "blogContent": "<p>HTML or rich text content...</p>"
    },
    {
      "_id": "playlist-item-5",
      "contentType": "quiz",
      "title": "Lesson Final Quiz",
      "duration": 20,
      "order": 4,
      "quiz": {
        "questions": [
          {
            "questionText": "What is Node.js?",
            "allowMultipleAnswers": false,
            "options": [
              { "text": "A JavaScript runtime", "isCorrect": true },
              { "text": "A database", "isCorrect": false }
            ]
          },
          {
            "questionText": "Select valid HTTP methods",
            "allowMultipleAnswers": true,
            "options": [
              { "text": "GET", "isCorrect": true },
              { "text": "POST", "isCorrect": true },
              { "text": "FOO", "isCorrect": false }
            ]
          }
        ]
      }
    },
    {
      "_id": "playlist-item-6",
      "contentType": "test",
      "title": "Final Assessment",
      "duration": 30,
      "order": 5,
      "testLinkOrReference": "https://forms.yourdomain.com/node-final"
    }
  ],
  "createdAt": "2026-02-11T12:49:45.513Z",
  "updatedAt": "2026-02-11T12:52:10.000Z"
}
```

---

### 3) Create/Update request contract

Both create and update use `multipart/form-data`.

#### 3.1 Top-level fields

| Field | Type | Required (create) | Notes |
|---|---|---|---|
| `moduleName` | string | Yes | |
| `shortDescription` | string | Yes | |
| `status` | string | No | `draft` / `published` / `archived` |
| `categories` | JSON string | No | Example: `["categoryId1","categoryId2"]` |
| `students` | JSON string | No | Example: `["studentId1","studentId2"]` |
| `mentorsAssigned` | JSON string | No | Example: `["mentorId1","mentorId2"]` |
| `coverImage` | File | Yes (create) | |
| `playlist` | JSON string | No | Array of playlist items (see below) |
| `playlist[i].videoFile` | File | If `upload-video` | |
| `playlist[i].pdfFile` | File | If `pdf-document` | |

#### 3.2 Playlist JSON shape

Send in `playlist` as JSON string:

```jsonc
[
  {
    "_id": "optional-playlist-item-id-on-update",
    "contentType": "upload-video",
    "title": "Lesson 1",
    "duration": 15
  },
  {
    "_id": "optional-playlist-item-id-on-update",
    "contentType": "pdf-document",
    "title": "Slides",
    "duration": 5
  },
  {
    "_id": "optional-playlist-item-id-on-update",
    "contentType": "youtube-link",
    "title": "External Video",
    "duration": 10,
    "youtubeUrl": "https://www.youtube.com/watch?v=abcd1234"
  },
  {
    "_id": "optional-playlist-item-id-on-update",
    "contentType": "blog",
    "title": "Article",
    "duration": 10,
    "blogContent": "<p>Rich text content...</p>"
  },
  {
    "_id": "optional-playlist-item-id-on-update",
    "contentType": "quiz",
    "title": "Final Quiz",
    "duration": 20,
    "quizData": {
      "questions": [
        {
          "questionText": "What is Node.js?",
          "allowMultipleAnswers": false,
          "options": [
            { "text": "A JavaScript runtime", "isCorrect": true },
            { "text": "A database", "isCorrect": false }
          ]
        }
      ]
    }
  },
  {
    "_id": "optional-playlist-item-id-on-update",
    "contentType": "test",
    "title": "Assessment",
    "duration": 30,
    "testLinkOrReference": "https://forms.example.com/final"
  }
]
```

For quiz items:

- Use `quizData.questions[]` when sending from form builder.
- Backend stores this inline at `playlist[i].quiz.questions`.

---

### 4) Frontend request builder example

```js
async function saveTrainingModule({ baseUrl, token, moduleId, module }) {
  const formData = new FormData();

  formData.append('moduleName', module.moduleName);
  formData.append('shortDescription', module.shortDescription);
  formData.append('status', module.status || 'draft');
  formData.append('categories', JSON.stringify(module.categories || []));
  formData.append('students', JSON.stringify(module.students || []));
  formData.append('mentorsAssigned', JSON.stringify(module.mentorsAssigned || []));

  if (module.coverImage instanceof File) {
    formData.append('coverImage', module.coverImage);
  }

  const playlistForJson = (module.playlist || []).map((item) => {
    const base = {
      _id: item._id,
      contentType: item.contentType,
      title: item.title,
      duration: item.duration || 0,
      order: item.order
    };

    if (item.contentType === 'youtube-link') return { ...base, youtubeUrl: item.youtubeUrl };
    if (item.contentType === 'blog') return { ...base, blogContent: item.blogContent };
    if (item.contentType === 'test') return { ...base, testLinkOrReference: item.testLinkOrReference };
    if (item.contentType === 'quiz') {
      return {
        ...base,
        quizData: item.quizData || item.quiz
      };
    }
    return base;
  });

  formData.append('playlist', JSON.stringify(playlistForJson));

  (module.playlist || []).forEach((item, index) => {
    if (item.contentType === 'upload-video' && item.videoFile instanceof File) {
      formData.append(`playlist[${index}].videoFile`, item.videoFile);
    }
    if (item.contentType === 'pdf-document' && item.pdfFile instanceof File) {
      formData.append(`playlist[${index}].pdfFile`, item.pdfFile);
    }
  });

  const isUpdate = Boolean(moduleId);
  const url = isUpdate
    ? `${baseUrl}/v1/training/modules/${moduleId}`
    : `${baseUrl}/v1/training/modules`;

  const res = await fetch(url, {
    method: isUpdate ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: formData
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to save module');
  }
  return res.json();
}
```

---

### 5) Notes

- There is **no `/v1/training/quizzes` endpoint** anymore.
- Quiz data must be sent as part of module payload (`playlist[].quizData`).
- For update, if frontend sends playlist items with `_id`, backend can preserve existing inline quiz if quizData is not resent.
- List and detail APIs both return quiz data inline under `playlist[].quiz`.

