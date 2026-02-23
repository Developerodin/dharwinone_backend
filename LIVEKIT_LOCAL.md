# LiveKit Local Setup (Docker)

## Option 1: Full stack (LiveKit + Egress + Redis + MinIO)

Use this for **recordings** and full meeting features.

```bash
npm run docker:livekit:full
```

Or: `docker compose -f livekit/docker-compose.yml up -d`

See `livekit/README.md` for details. Uses keys from `.env`: `devkey` / `devsecret123456789012345678901234`.

## Option 2: Lightweight (LiveKit + MinIO only)

No Egress, no Redis. Meetings work but **recordings will not**.

```bash
npm run docker:livekit
```

Or: `docker compose -f docker-compose.livekit-local.yml up -d`

**Note:** This uses `--dev` mode with API secret `secret`. Use `LIVEKIT_API_SECRET=secret` in `.env` for this option, or use the full stack above which matches your `.env` credentials.

## Backend .env (for full stack)

```
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret123456789012345678901234
MINIO_ENDPOINT=http://minio:9000
MINIO_PUBLIC_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin123
MINIO_BUCKET=recordings
```

## Stop

- Full stack: `npm run docker:livekit:full:down`
- Lightweight: `npm run docker:livekit:down`
