/* eslint-disable no-console */
import 'dotenv/config';
import mongoose from 'mongoose';
import crypto from 'crypto';
import config from '../src/config/config.js';
import Recording from '../src/models/recording.model.js';
import AgentDispatch from '../src/models/agentDispatch.model.js';
import { signAgentRequest } from '../src/middlewares/agentAuth.js';

const API_BASE = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function main() {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);

  const meetingId = `meeting_smoke_${crypto.randomBytes(4).toString('hex')}`;
  const recording = await Recording.create({
    meetingId,
    egressId: `EGR_${meetingId}`,
    status: 'recording',
    aiProcessingStatus: 'dispatching',
    statusRank: 1,
  });

  const hmacToken = crypto.randomBytes(32).toString('hex');
  await AgentDispatch.create({
    meetingId,
    recordingId: recording._id,
    dispatchId: `disp_${meetingId}`,
    hmacToken,
    status: 'requested',
  });

  async function post(path, body) {
    const raw = JSON.stringify(body);
    const ts = String(Date.now());
    const sig = signAgentRequest({ token: hmacToken, timestamp: ts, body: raw });
    const res = await fetch(`${API_BASE}/v1/internal/meetings/${meetingId}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Timestamp': ts,
        'X-Agent-Signature': sig,
      },
      body: raw,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`POST ${path} -> ${res.status} ${t}`);
    }
    return res.json();
  }

  console.log('1. agent-joined');
  console.log(await post('/agent-joined', { roomSid: 'RM_smoke', participantCount: 2 }));

  console.log('2. transcript-segments x2');
  console.log(
    await post('/transcript-segments', {
      segments: [
        {
          sequenceNumber: 0,
          windowStartMs: 0,
          windowEndMs: 30000,
          combinedText:
            "Alice: let's decide python. Bob: agreed, action item Alice writes the spec.",
          utterances: [
            {
              speaker: 'u_alice',
              speakerName: 'Alice',
              text: "Let's decide python.",
              startMs: 1000,
              endMs: 4000,
              speakerSource: 'livekit',
              confidence: 0.92,
            },
            {
              speaker: 'u_bob',
              speakerName: 'Bob',
              text: 'Agreed, action item Alice writes the spec.',
              startMs: 4500,
              endMs: 9000,
              speakerSource: 'livekit',
              confidence: 0.95,
            },
          ],
        },
        {
          sequenceNumber: 1,
          windowStartMs: 30000,
          windowEndMs: 60000,
          combinedText: 'Alice: draft by Friday. blocker: deepgram key.',
          utterances: [
            {
              speaker: 'u_alice',
              speakerName: 'Alice',
              text: 'Draft by Friday. blocker: deepgram key.',
              startMs: 31000,
              endMs: 36000,
              speakerSource: 'livekit',
              confidence: 0.91,
            },
          ],
        },
      ],
    })
  );

  await new Promise((r) => setTimeout(r, 6000));

  console.log('3. finalize');
  console.log(await post('/finalize', { totalSegments: 2, durationMs: 60000 }));

  console.log(`\nSmoke meeting created: ${meetingId}`);
  console.log('Watch the worker; then re-check:');
  console.log("  Recording.aiProcessingStatus → should reach 'completed'");
  console.log(`  Summary doc for ${meetingId} → should exist with executiveSummary populated`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
