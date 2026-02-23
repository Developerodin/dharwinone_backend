# LiveKit Cloud Migration Guide

This guide walks you through switching from self-hosted LiveKit (Docker) to **LiveKit Cloud** (hosted API).

## Overview

- **Local Docker:** LiveKit server, Egress, Redis, MinIO run in containers; recordings stored in MinIO.
- **LiveKit Cloud:** LiveKit and Egress run on LiveKit's infrastructure; recordings stored in **AWS S3**.

## Prerequisites

- LiveKit Cloud account: [cloud.livekit.io](https://cloud.livekit.io)
- AWS S3 bucket for recordings (and existing AWS credentials in your backend)

## Step 1: Create a LiveKit Cloud Project

1. Go to [cloud.livekit.io](https://cloud.livekit.io) and sign in.
2. Create a new project (or use an existing one).
3. In the project dashboard, note:
   - **WebSocket URL:** `wss://<project-name>.livekit.cloud`
   - **API Key**
   - **API Secret**

## Step 2: Configure Backend `.env`

Replace your Docker/Local LiveKit vars with Cloud values:

```env
# LiveKit Cloud
LIVEKIT_URL=wss://YOUR_PROJECT.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret

# Recordings: AWS S3 (required for Cloud; Egress uploads here)
LIVEKIT_S3_BUCKET=recordings
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
AWS_REGION=us-east-1
```

- You can reuse `AWS_S3_BUCKET_NAME` or set a dedicated `LIVEKIT_S3_BUCKET` for recordings.
- MinIO vars are **not needed** when using LiveKit Cloud (they are ignored).

## Step 3: Configure Frontend `.env`

Update the frontend LiveKit URL so the browser connects to LiveKit Cloud:

```env
NEXT_PUBLIC_LIVEKIT_URL=wss://YOUR_PROJECT.livekit.cloud
```

## Step 4: Create S3 Bucket (if needed)

If you don't have a recordings bucket:

1. In AWS S3 console, create a bucket (e.g. `your-app-recordings`).
2. Set `LIVEKIT_S3_BUCKET=your-app-recordings` in backend `.env`.

## Step 5: Stop Local LiveKit Docker

You no longer need the local LiveKit stack:

```bash
cd livekit
docker compose down
# or from backend root:
npm run docker:livekit:full:down
```

## How It Works

- **Token generation:** Same backend endpoint `/v1/livekit/token`; it now uses your Cloud project URL and credentials.
- **Recording:** When you start recording, the backend calls LiveKit Cloud’s API with the S3 config; LiveKit’s Egress uploads MP4 files to your S3 bucket.
- **Playback:** The backend generates presigned URLs for playback from S3.

## Egress Webhook (recordings completion)

When an egress finishes, LiveKit sends `egress_ended` webhooks. Configure your webhook URL so the backend can update recordings with `completedAt` and `status`.

**Webhook URL:** `https://YOUR_BACKEND_URL/v1/webhooks/livekit-egress`

Example with ngrok: `https://inspiratory-cristie-cherishingly.ngrok-free.dev/v1/webhooks/livekit-egress`

- **LiveKit Cloud:** Project → Settings → Webhooks → Add URL
- **Self-hosted:** Add to `server.yaml` under `webhook.urls`

The endpoint receives `egress_ended` events, finds the Recording by `egressId`, and sets `status: completed` and `completedAt` from the payload.

## Troubleshooting

| Issue | Check |
|-------|-------|
| "LiveKit credentials not configured" | Ensure `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are set in backend `.env` |
| Recording fails | Verify AWS credentials and `LIVEKIT_S3_BUCKET`; ensure bucket exists |
| Can't join room | Ensure `NEXT_PUBLIC_LIVEKIT_URL` in frontend matches your Cloud WebSocket URL (`wss://...`) |
| Webhook not received | Use ngrok or a public URL; add it in LiveKit Cloud Settings → Webhooks |
