# Frontend Profile Image API Documentation

## Overview

This document provides complete frontend integration guide for uploading, previewing, and downloading profile images for **Students** and **Mentors**.

---

## Table of Contents

1. [API Endpoints](#api-endpoints)
2. [Upload Profile Image](#upload-profile-image)
3. [Preview Profile Image](#preview-profile-image)
4. [Download Profile Image](#download-profile-image)
5. [Complete React Examples](#complete-react-examples)
6. [Error Handling](#error-handling)
7. [Best Practices](#best-practices)

---

## API Endpoints

### Student Profile Image

- **Upload**: `POST /v1/training/students/:studentId/profile-image`
- **Get/Preview**: `GET /v1/training/students/:studentId/profile-image`

### Mentor Profile Image

- **Upload**: `POST /v1/training/mentors/:mentorId/profile-image`
- **Get/Preview**: `GET /v1/training/mentors/:mentorId/profile-image`

**Base URL**: `http://localhost:3000` (development) or your production URL

---

## Upload Profile Image

### Endpoint Details

- **Method**: `POST`
- **URL**: `/v1/training/students/:studentId/profile-image` or `/v1/training/mentors/:mentorId/profile-image`
- **Authentication**: Required (Bearer token)
- **Content-Type**: `multipart/form-data`
- **Permissions**: User must have `students.manage` or `mentors.manage` permission

### Request Format

**Headers:**
```
Authorization: Bearer <access_token>
```

**Body (form-data):**
- `file`: Image file (png, jpg, jpeg, etc.)

### Response Format

**Success (200 OK):**
```json
{
  "id": "66c9f2f0c5e2d9e3b9b12345",
  "user": { ... },
  "profileImage": {
    "key": "student-profile-images/userId/timestamp-random.png",
    "url": "https://s3.amazonaws.com/bucket/...",
    "originalName": "avatar.png",
    "size": 12345,
    "mimeType": "image/png",
    "uploadedAt": "2026-02-11T10:00:00.000Z"
  },
  "profileImageUrl": "https://s3.amazonaws.com/bucket/...",
  ...
}
```

**Error (400 Bad Request):**
```json
{
  "code": 400,
  "message": "No file provided"
}
```

**Error (401 Unauthorized):**
```json
{
  "code": 401,
  "message": "Please authenticate"
}
```

**Error (403 Forbidden):**
```json
{
  "code": 403,
  "message": "Forbidden"
}
```

### JavaScript/React Upload Example

```javascript
/**
 * Upload profile image for student or mentor
 * @param {string} baseUrl - API base URL
 * @param {string} token - Access token
 * @param {string} type - 'student' or 'mentor'
 * @param {string} id - Student ID or Mentor ID
 * @param {File} file - Image file from input
 * @returns {Promise<Object>} Updated student/mentor object
 */
async function uploadProfileImage({ baseUrl, token, type, id, file }) {
  const formData = new FormData();
  formData.append('file', file);

  const endpoint = type === 'student' 
    ? `/v1/training/students/${id}/profile-image`
    : `/v1/training/mentors/${id}/profile-image`;

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // DO NOT set Content-Type manually - browser will set it with boundary
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to upload profile image');
  }

  return await response.json();
}

// Usage example
const handleFileUpload = async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const updatedStudent = await uploadProfileImage({
      baseUrl: 'http://localhost:3000',
      token: userToken,
      type: 'student',
      id: studentId,
      file: file,
    });
    
    console.log('Profile image uploaded:', updatedStudent.profileImage);
    // Update UI with new image
  } catch (error) {
    console.error('Upload failed:', error.message);
    // Show error message to user
  }
};
```

---

## Preview Profile Image

### Endpoint Details

- **Method**: `GET`
- **URL**: `/v1/training/students/:studentId/profile-image` or `/v1/training/mentors/:mentorId/profile-image`
- **Authentication**: Required (Bearer token)
- **Permissions**: User must have `students.read` or `mentors.read` permission

### Request Options

#### Option A: JSON Response (Recommended for React `<img />`)

**Headers:**
```
Authorization: Bearer <access_token>
Accept: application/json
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "url": "https://s3.amazonaws.com/bucket/...?X-Amz-Signature=...",
    "mimeType": "image/png"
  }
}
```

**Note**: The presigned URL expires after **1 hour**. Fetch a new URL when needed.

#### Option B: Direct Redirect (For Browser Links)

**Headers:**
```
Authorization: Bearer <access_token>
```

**Behavior**: Server returns **302 redirect** to presigned S3 URL. Browser automatically follows redirect and displays/downloads image.

### JavaScript/React Preview Examples

#### Example 1: Fetch URL and Display in `<img />` Tag

```javascript
/**
 * Get profile image URL for student or mentor
 * @param {string} baseUrl - API base URL
 * @param {string} token - Access token
 * @param {string} type - 'student' or 'mentor'
 * @param {string} id - Student ID or Mentor ID
 * @returns {Promise<string>} Presigned image URL
 */
async function getProfileImageUrl({ baseUrl, token, type, id }) {
  const endpoint = type === 'student'
    ? `/v1/training/students/${id}/profile-image`
    : `/v1/training/mentors/${id}/profile-image`;

  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null; // No profile image
    }
    throw new Error('Failed to fetch profile image URL');
  }

  const json = await response.json();
  return json.data.url;
}

// Usage in React component
function ProfileImage({ baseUrl, token, type, id }) {
  const [imageUrl, setImageUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchImage = async () => {
      try {
        setLoading(true);
        const url = await getProfileImageUrl({ baseUrl, token, type, id });
        setImageUrl(url);
        setError(null);
      } catch (err) {
        setError(err.message);
        setImageUrl(null);
      } finally {
        setLoading(false);
      }
    };

    if (id && token) {
      fetchImage();
    }
  }, [baseUrl, token, type, id]);

  if (loading) {
    return <div className="profile-image-placeholder">Loading...</div>;
  }

  if (error || !imageUrl) {
    return (
      <div className="profile-image-placeholder">
        <img src="/default-avatar.png" alt="Default avatar" />
      </div>
    );
  }

  return (
    <img 
      src={imageUrl} 
      alt={`${type} profile`}
      className="profile-image"
      onError={() => {
        // Handle expired URL - fetch new one
        setImageUrl(null);
        setLoading(true);
      }}
    />
  );
}
```

#### Example 2: Open Image in New Tab (Direct Redirect)

```javascript
/**
 * Open profile image in new tab (uses redirect)
 * @param {string} baseUrl - API base URL
 * @param {string} token - Access token
 * @param {string} type - 'student' or 'mentor'
 * @param {string} id - Student ID or Mentor ID
 */
function openProfileImageInNewTab({ baseUrl, token, type, id }) {
  const endpoint = type === 'student'
    ? `/v1/training/students/${id}/profile-image`
    : `/v1/training/mentors/${id}/profile-image`;

  // Append token as query parameter for redirect flow
  const url = `${baseUrl}${endpoint}?token=${encodeURIComponent(token)}`;
  window.open(url, '_blank');
}
```

---

## Download Profile Image

### Method 1: Using Presigned URL (Recommended)

```javascript
/**
 * Download profile image
 * @param {string} baseUrl - API base URL
 * @param {string} token - Access token
 * @param {string} type - 'student' or 'mentor'
 * @param {string} id - Student ID or Mentor ID
 * @param {string} fileName - Optional filename for download
 */
async function downloadProfileImage({ baseUrl, token, type, id, fileName = 'profile-image' }) {
  try {
    // Get presigned URL
    const imageUrl = await getProfileImageUrl({ baseUrl, token, type, id });
    
    // Fetch image blob
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    
    // Create download link
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Download failed:', error);
    throw error;
  }
}
```

### Method 2: Direct Link with Download Attribute

```javascript
// In your JSX/HTML
<a 
  href={`${baseUrl}/v1/training/students/${studentId}/profile-image?token=${token}`}
  download="student-profile.png"
  target="_blank"
>
  Download Profile Image
</a>
```

---

## Complete React Examples

### Complete Profile Image Component with Upload

```jsx
import React, { useState, useEffect } from 'react';

function ProfileImageManager({ baseUrl, token, type, id }) {
  const [imageUrl, setImageUrl] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch current profile image
  const fetchImage = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const endpoint = type === 'student'
        ? `/v1/training/students/${id}/profile-image`
        : `/v1/training/mentors/${id}/profile-image`;

      const response = await fetch(`${baseUrl}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (response.status === 404) {
        setImageUrl(null);
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to fetch profile image');
      }

      const json = await response.json();
      setImageUrl(json.data.url);
    } catch (err) {
      setError(err.message);
      setImageUrl(null);
    } finally {
      setLoading(false);
    }
  };

  // Upload new profile image
  const handleUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file');
      return;
    }

    // Validate file size (e.g., max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setError('Image size must be less than 5MB');
      return;
    }

    try {
      setUploading(true);
      setError(null);

      const formData = new FormData();
      formData.append('file', file);

      const endpoint = type === 'student'
        ? `/v1/training/students/${id}/profile-image`
        : `/v1/training/mentors/${id}/profile-image`;

      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Upload failed');
      }

      const updated = await response.json();
      
      // Refresh image URL
      await fetchImage();
      
      // Show success message
      alert('Profile image uploaded successfully!');
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    if (id && token) {
      fetchImage();
    }
  }, [baseUrl, token, type, id]);

  return (
    <div className="profile-image-manager">
      <div className="profile-image-container">
        {loading ? (
          <div className="profile-image-placeholder">Loading...</div>
        ) : imageUrl ? (
          <img 
            src={imageUrl} 
            alt={`${type} profile`}
            className="profile-image"
            onError={() => {
              // URL expired, fetch new one
              fetchImage();
            }}
          />
        ) : (
          <div className="profile-image-placeholder">
            <img src="/default-avatar.png" alt="No profile image" />
          </div>
        )}
      </div>

      <div className="profile-image-actions">
        <label htmlFor="profile-image-upload" className="upload-button">
          {uploading ? 'Uploading...' : 'Change Picture'}
          <input
            id="profile-image-upload"
            type="file"
            accept="image/*"
            onChange={handleUpload}
            disabled={uploading}
            style={{ display: 'none' }}
          />
        </label>

        {imageUrl && (
          <button
            onClick={() => window.open(imageUrl, '_blank')}
            className="preview-button"
          >
            Preview Full Size
          </button>
        )}
      </div>

      {error && (
        <div className="error-message" style={{ color: 'red', marginTop: '10px' }}>
          {error}
        </div>
      )}
    </div>
  );
}

export default ProfileImageManager;
```

### Usage:

```jsx
// For Student
<ProfileImageManager 
  baseUrl="http://localhost:3000"
  token={userToken}
  type="student"
  id={studentId}
/>

// For Mentor
<ProfileImageManager 
  baseUrl="http://localhost:3000"
  token={userToken}
  type="mentor"
  id={mentorId}
/>
```

---

## Error Handling

### Common Error Codes

| Status Code | Meaning | Solution |
|------------|---------|----------|
| 400 | Bad Request (e.g., no file provided) | Ensure file is included in form-data |
| 401 | Unauthorized | Check if token is valid and included in headers |
| 403 | Forbidden | User doesn't have required permissions |
| 404 | Not Found | Student/Mentor doesn't exist or no profile image |
| 500 | Internal Server Error | Server issue - contact backend team |

### Error Handling Example

```javascript
async function uploadProfileImageWithErrorHandling({ baseUrl, token, type, id, file }) {
  try {
    const formData = new FormData();
    formData.append('file', file);

    const endpoint = type === 'student'
      ? `/v1/training/students/${id}/profile-image`
      : `/v1/training/mentors/${id}/profile-image`;

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      
      switch (response.status) {
        case 400:
          throw new Error(`Invalid request: ${error.message}`);
        case 401:
          throw new Error('Authentication required. Please login again.');
        case 403:
          throw new Error('You do not have permission to upload profile images.');
        case 404:
          throw new Error(`${type} not found.`);
        case 500:
          throw new Error('Server error. Please try again later.');
        default:
          throw new Error(error.message || 'Upload failed');
      }
    }

    return await response.json();
  } catch (error) {
    // Handle network errors
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new Error('Network error. Please check your connection.');
    }
    throw error;
  }
}
```

---

## Best Practices

### 1. **File Validation (Client-Side)**

```javascript
function validateImageFile(file) {
  // Check file type
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    return { valid: false, error: 'Only JPEG, PNG, GIF, and WebP images are allowed' };
  }

  // Check file size (e.g., max 5MB)
  const maxSize = 5 * 1024 * 1024; // 5MB
  if (file.size > maxSize) {
    return { valid: false, error: 'Image size must be less than 5MB' };
  }

  return { valid: true };
}
```

### 2. **Image Preview Before Upload**

```javascript
function previewImageBeforeUpload(file, previewElementId) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const preview = document.getElementById(previewElementId);
    preview.src = e.target.result;
    preview.style.display = 'block';
  };
  reader.readAsDataURL(file);
}
```

### 3. **Handle Expired URLs**

Presigned URLs expire after 1 hour. Always handle expired URLs gracefully:

```javascript
<img 
  src={imageUrl}
  onError={(e) => {
    // Fetch fresh URL when current one expires
    fetchImageUrl().then(newUrl => {
      e.target.src = newUrl;
    });
  }}
/>
```

### 4. **Loading States**

Always show loading states during upload and fetch operations:

```javascript
const [uploading, setUploading] = useState(false);
const [loading, setLoading] = useState(true);
```

### 5. **Caching Strategy**

Consider caching profile image URLs in your state management (Redux, Context, etc.) to avoid unnecessary API calls:

```javascript
// In your state/store
const profileImageCache = new Map();

async function getCachedProfileImageUrl({ baseUrl, token, type, id }) {
  const cacheKey = `${type}-${id}`;
  
  // Check cache first
  if (profileImageCache.has(cacheKey)) {
    const cached = profileImageCache.get(cacheKey);
    // Refresh if older than 50 minutes (before 1 hour expiry)
    if (Date.now() - cached.timestamp < 50 * 60 * 1000) {
      return cached.url;
    }
  }

  // Fetch new URL
  const url = await getProfileImageUrl({ baseUrl, token, type, id });
  profileImageCache.set(cacheKey, { url, timestamp: Date.now() });
  return url;
}
```

---

## Summary

### Quick Reference

**Upload:**
```javascript
POST /v1/training/students/:studentId/profile-image
POST /v1/training/mentors/:mentorId/profile-image
Body: form-data with 'file' field
```

**Preview:**
```javascript
GET /v1/training/students/:studentId/profile-image
GET /v1/training/mentors/:mentorId/profile-image
Headers: Accept: application/json (for JSON response)
```

**Key Points:**
- ✅ Always include `Authorization: Bearer <token>` header
- ✅ Use `form-data` for uploads (don't set Content-Type manually)
- ✅ Presigned URLs expire after 1 hour - handle expiration gracefully
- ✅ Validate file type and size on client-side before upload
- ✅ Show loading states and error messages to users

---

## Support

For issues or questions, contact the backend team or refer to the API documentation.
