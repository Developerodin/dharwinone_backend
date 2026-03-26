# LiveKit Integration Setup Guide

This guide explains how to set up and use LiveKit video meetings in the dharwin_new backend.

> **Using LiveKit Cloud instead of Docker?** See [LIVEKIT_CLOUD_MIGRATION.md](./LIVEKIT_CLOUD_MIGRATION.md) for switching to the hosted API.

## Overview

LiveKit integration provides Google Meet-like video conferencing functionality. The backend handles:
- Generating access tokens for participants
- Starting/stopping room recordings
- Managing recording status

## Prerequisites

1. **Docker and Docker Compose** installed
2. **LiveKit services running** (see [LIVEKIT_DOCKER_README.md](./LIVEKIT_DOCKER_README.md) and [LIVEKIT_LOCAL.md](./LIVEKIT_LOCAL.md); compose files live under `../livekit/`)

## Backend Setup

### 1. Install Dependencies

The `livekit-server-sdk` package is already installed. If you need to reinstall:

```bash
npm install livekit-server-sdk
```

### 2. Environment Variables

Add the following to your `.env` file (see `.env.example` for reference):

```env
# LiveKit Configuration
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret123456789012345678901234

# MinIO configuration for local development recordings
MINIO_ENDPOINT=http://minio:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin123
MINIO_BUCKET=recordings
```

**Note:** The `MINIO_ENDPOINT` uses `http://minio:9000` (Docker service name) because the backend may run in Docker. If running locally, you might need `http://localhost:9000` depending on your setup.

### 3. Start LiveKit Services

From the `livekit-local` directory:

```bash
cd ../livekit-local
docker compose up -d
```

Verify services are running:
```bash
docker compose ps
```

## API Endpoints

All endpoints are under `/v1/livekit` and require authentication.

### 1. Generate Access Token

**POST** `/v1/livekit/token`

Generate a LiveKit access token for joining a room.

**Request Body:**
```json
{
  "roomName": "training-module-123",
  "participantName": "John Doe" // Optional, defaults to authenticated user's name
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "roomName": "training-module-123",
  "participantName": "John Doe",
  "participantIdentity": "user-id-123"
}
```

**Authentication:** Required (any authenticated user)

### 2. Start Recording

**POST** `/v1/livekit/recording/start`

Start recording a room session.

**Request Body:**
```json
{
  "roomName": "training-module-123"
}
```

**Response:**
```json
{
  "success": true,
  "egressId": "EG_xxxxx",
  "roomName": "training-module-123",
  "status": "EGRESS_STARTING",
  "message": "Recording started"
}
```

**Authentication:** Required + `meetings.record` permission

### 3. Stop Recording

**POST** `/v1/livekit/recording/stop`

Stop an active recording.

**Request Body:**
```json
{
  "egressId": "EG_xxxxx"
}
```

**Response:**
```json
{
  "success": true,
  "egressId": "EG_xxxxx",
  "status": "EGRESS_COMPLETE",
  "message": "Recording stopped"
}
```

**Authentication:** Required + `meetings.record` permission

### 4. Get Recording Status

**GET** `/v1/livekit/recording/status/:roomName`

Get recording status for a room.

**Response:**
```json
{
  "isRecording": true,
  "recordings": [
    {
      "egressId": "EG_xxxxx",
      "roomName": "training-module-123",
      "status": "EGRESS_ACTIVE",
      "startedAt": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

**Authentication:** Required + `meetings.record` permission

## Permissions

The `meetings.record` permission is required for recording endpoints. This permission is granted to:
- Users with `meetings.record` permission
- Users with `mentors.manage` permission
- Users with `training.manage` permission

See `src/config/permissions.js` for permission aliases.

## Usage Example

### Frontend Integration Flow

1. **User clicks "Join Meeting"** → Frontend calls `POST /v1/livekit/token` with `roomName`
2. **Backend returns token** → Frontend uses token to connect to LiveKit server
3. **User joins room** → LiveKit handles WebRTC connection
4. **Start recording** (optional) → Frontend calls `POST /v1/livekit/recording/start`
5. **Stop recording** → Frontend calls `POST /v1/livekit/recording/stop`

### Room Naming Conventions

Recommended room naming patterns:
- Training module: `training-module-<moduleId>-<timestamp>`
- Mentor-student session: `session-<mentorId>-<studentId>-<date>`
- General meeting: `meeting-<meetingId>`

## Recording Storage

### Local Development (MinIO)

Recordings are stored in MinIO (S3-compatible storage):
- Access MinIO Console: http://localhost:9001
- Credentials: `minioadmin` / `minioadmin123`
- Bucket: `recordings`

### Production (AWS S3)

For production, configure AWS S3 in `.env`:
```env
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1
AWS_S3_BUCKET_NAME=your-recordings-bucket
# Optional: Override bucket for recordings
LIVEKIT_S3_BUCKET=your-recordings-bucket
```

The service automatically detects production mode and uses S3 instead of MinIO.

## Troubleshooting

### "Recording service not available"

- Ensure LiveKit Egress service is running: `docker compose ps` in `livekit-local`
- Check Egress logs: `docker compose logs egress`

### "Room not found"

- Ensure participants have joined the room before starting recording
- Verify room name matches exactly

### Token generation fails

- Check `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in `.env`
- Verify LiveKit server is accessible at `LIVEKIT_URL`

## Architecture

```
┌─────────────┐
│   Frontend  │
│  (React)    │
└──────┬──────┘
       │ HTTP/WebSocket
       │ (with token)
       ▼
┌─────────────┐     ┌──────────────┐
│ LiveKit     │◄────┤   Redis      │
│ Server      │     │  (Message   │
│ (Docker)    │     │   Bus)       │
└──────┬──────┘     └──────────────┘
       │
       │ WebRTC
       ▼
┌─────────────┐     ┌──────────────┐
│ Participants│     │   Egress     │
│  (Browser)  │     │  (Recording) │
└─────────────┘     └──────┬───────┘
                            │
                            ▼
                    ┌──────────────┐
                    │   MinIO/S3   │
                    │  (Storage)   │
                    └──────────────┘
```

## Next Steps

- Confirm recordings and egress using [LIVEKIT_DOCKER_README.md](./LIVEKIT_DOCKER_README.md) and [LIVEKIT_CLOUD_MIGRATION.md](./LIVEKIT_CLOUD_MIGRATION.md) as needed
- Frontend: align `NEXT_PUBLIC_LIVEKIT_URL` with your LiveKit WebSocket URL
