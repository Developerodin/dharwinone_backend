# LiveKit Stack (with Egress)

Full LiveKit stack for meetings and recordings: LiveKit server, Egress, Redis, MinIO.

## Quick Start

From `uat.dharwin.backend`:

```bash
npm run docker:livekit:full
```

Or manually:

```bash
docker compose -f livekit/docker-compose.yml up -d
```

## Credentials (.env)

Uses credentials from `uat.dharwin.backend/.env`:

| Variable | Value | Purpose |
|----------|-------|---------|
| LIVEKIT_URL | ws://localhost:7880 | Backend/frontend connect here |
| LIVEKIT_API_KEY | devkey | Must match server.yaml keys |
| LIVEKIT_API_SECRET | devsecret123456789012345678901234 | Must match server.yaml keys |
| MINIO_ENDPOINT | http://minio:9000 | Used by Egress (backend passes to SDK) |
| MINIO_ACCESS_KEY | minioadmin | MinIO credentials |
| MINIO_SECRET_KEY | minioadmin123 | MinIO credentials |
| MINIO_BUCKET | recordings | Recordings bucket |

## Services

| Service | Port | Description |
|---------|------|-------------|
| LiveKit | 7880 | WebSocket signal |
| LiveKit | 7881 | WebRTC TCP |
| LiveKit | 50000-60000 | WebRTC UDP |
| Redis | 6379 | Coordination for LiveKit + Egress |
| Egress | 8080 | Health (internal) |
| MinIO | 9000 | S3-compatible storage |
| MinIO UI | 9001 | MinIO console |

## Stop

```bash
npm run docker:livekit:full:down
# or
docker compose -f livekit/docker-compose.yml down
```
