import OpenAI from 'openai';
import config from '../config/config.js';
import { costForUsage } from '../config/llmPricing.js';
import TranscriptSegment from '../models/transcriptSegment.model.js';
import TranscriptSession from '../models/transcriptSession.model.js';
import TranscriptBatch from '../models/transcriptBatch.model.js';
import { utterancesFromBatches } from './agentInternalV2.helpers.js';
import Summary from '../models/summary.model.js';
import Recording from '../models/recording.model.js';
import logger from '../config/logger.js';
import { uploadJsonToS3, readJsonFromS3 } from './aiArtifactStorage.service.js';

const CHARS_PER_TOKEN = 4;

export function estimateTranscriptTokens(segments = []) {
  let chars = 0;
  for (const s of segments) chars += (s.combinedText || '').length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function applyCostGate({ estTokens, durationMinutes }) {
  if (estTokens > config.ai.maxTranscriptTokens) {
    return {
      ok: false,
      reason: `transcript tokens (${estTokens}) exceed MAX_TRANSCRIPT_TOKENS (${config.ai.maxTranscriptTokens})`,
    };
  }
  if (durationMinutes > config.ai.maxMeetingDurationMinutes) {
    return {
      ok: false,
      reason: `meeting duration (${durationMinutes} min) exceeds MAX_MEETING_DURATION_MINUTES (${config.ai.maxMeetingDurationMinutes})`,
    };
  }
  return { ok: true };
}

export function splitUtterancesIntoWindows(utterances = [], maxTokens = config.ai.mapWindowTokens) {
  if (!utterances.length) return [];
  const windows = [];
  let current = [];
  let tokens = 0;
  let prevSpeaker = null;

  for (const u of utterances) {
    const t = Math.ceil((u.text || '').length / CHARS_PER_TOKEN);
    const speakerChanged = prevSpeaker !== null && u.speaker !== prevSpeaker;
    if (tokens + t > maxTokens && speakerChanged && current.length > 0) {
      windows.push(current);
      current = [];
      tokens = 0;
    }
    current.push(u);
    tokens += t;
    prevSpeaker = u.speaker;
  }
  if (current.length) windows.push(current);
  return windows;
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function callJsonModel(openai, { model, system, user, retries = 1 }) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resp = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });
    const content = resp.choices?.[0]?.message?.content;
    const parsed = safeJson(content);
    if (parsed) return { parsed, usage: resp.usage, cost: costForUsage(model, resp.usage) };
    if (attempt >= retries) return { parsed: null, usage: resp.usage, cost: costForUsage(model, resp.usage) };
    attempt += 1;
  }
}

function renderUtterancesForPrompt(utts) {
  return utts
    .map((u) => {
      const t = u.startMs ? `[${Math.floor(u.startMs / 1000)}s]` : '';
      const who = u.speakerName || u.speaker || u.speakerLabel || 'unknown';
      return `${t} ${who}: ${u.text}`;
    })
    .join('\n');
}

const MAP_SYSTEM =
  'Summarize this meeting segment. Output JSON keys: windowSummary (string, 2-3 sentences), windowBullets (array of strings, 3-7), actionCandidates (array of {text, owner, timestampMs}), decisionCandidates (array of {text, timestampMs}).';
const REDUCE_SYSTEM =
  'Combine these segment summaries into a single meeting summary. Output JSON: executiveSummary (3-5 sentences), bulletSummary (5-10 bullets).';
const EXTRACT_SYSTEM =
  'Deduplicate and refine the candidate items from a meeting. Output strict JSON: { actionItems: [{text, owner, dueHint, timestampMs}], decisions: [{text, timestampMs}], blockers: [string], nextSteps: [string], participantsActive: [{identity, name, speakingMs}] }';

export async function mapReduceSummarize({ utterances, durationMs, openai }) {
  const windows = splitUtterancesIntoWindows(utterances, config.ai.mapWindowTokens);
  let totalCost = 0;

  const parallel = Math.max(1, Number(config.ai.mapParallelism) || 5);
  const mapResults = new Array(windows.length);
  for (let i = 0; i < windows.length; i += parallel) {
    const slice = windows.slice(i, i + parallel);
    // eslint-disable-next-line no-await-in-loop
    const out = await Promise.all(
      slice.map((w) =>
        callJsonModel(openai, {
          model: config.ai.summaryModel,
          system: MAP_SYSTEM,
          user: renderUtterancesForPrompt(w),
          retries: 1,
        })
      )
    );
    for (let j = 0; j < out.length; j += 1) {
      mapResults[i + j] = out[j];
      totalCost += out[j].cost || 0;
    }
  }
  const goodMaps = mapResults.map(
    (r) => r.parsed || { windowSummary: '[unavailable]', windowBullets: [], actionCandidates: [], decisionCandidates: [] }
  );

  const reduceInput = goodMaps
    .map((m, i) => `Segment ${i + 1}: ${m.windowSummary}\n- ${(m.windowBullets || []).join('\n- ')}`)
    .join('\n\n');
  let reducePartial = false;
  const reduce = await callJsonModel(openai, {
    model: config.ai.summaryModel,
    system: REDUCE_SYSTEM,
    user: reduceInput,
    retries: 2,
  });
  totalCost += reduce.cost || 0;
  const executiveSummary = reduce.parsed?.executiveSummary || '[generation failed]';
  const bulletSummary = Array.isArray(reduce.parsed?.bulletSummary) ? reduce.parsed.bulletSummary : [];
  if (!reduce.parsed) reducePartial = true;

  const allCandidates = {
    actionCandidates: goodMaps.flatMap((m) => m.actionCandidates || []),
    decisionCandidates: goodMaps.flatMap((m) => m.decisionCandidates || []),
  };
  const extract = await callJsonModel(openai, {
    model: config.ai.extractionModel,
    system: EXTRACT_SYSTEM,
    user: JSON.stringify(allCandidates),
    retries: 1,
  });
  totalCost += extract.cost || 0;
  const extractedRaw = extract.parsed || {};
  const extractPartial = !extract.parsed;
  const actionItems = Array.isArray(extractedRaw.actionItems) ? extractedRaw.actionItems : [];
  const decisions = Array.isArray(extractedRaw.decisions) ? extractedRaw.decisions : [];
  const blockers = Array.isArray(extractedRaw.blockers) ? extractedRaw.blockers : [];
  const nextSteps = Array.isArray(extractedRaw.nextSteps) ? extractedRaw.nextSteps : [];
  const participantsActive = Array.isArray(extractedRaw.participantsActive) ? extractedRaw.participantsActive : [];

  return {
    executiveSummary,
    bulletSummary,
    actionItems,
    decisions,
    blockers,
    nextSteps,
    participantsActive,
    durationMs,
    llmCostUsd: Number(totalCost.toFixed(6)),
    partial: reducePartial || extractPartial,
  };
}

export function buildTranscriptJson(meetingId, segments, durationMs) {
  const utterances = [];
  for (const s of segments) {
    for (const u of s.utterances || []) utterances.push(u);
  }
  return { meetingId, durationMs, utterances };
}

let openaiClient = null;
function getOpenai() {
  if (openaiClient) return openaiClient;
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

export function buildSummaryClaimFilter({ meetingId, recordingId, now = Date.now(), staleMs }) {
  return {
    ...(recordingId ? { _id: recordingId } : { meetingId }),
    aiProcessingStatus: { $ne: 'completed' },
    $or: [{ summaryClaimedAt: null }, { summaryClaimedAt: { $lt: new Date(now - staleMs) } }],
  };
}

function utterancesFromTranscriptVersion(versionDoc) {
  const rows = versionDoc?.utterances || [];
  if (!rows.length) return { utterances: [], durationMs: 0 };
  const firstStart = rows[0].startedAtEpochMs || 0;
  const utterances = rows.map((u) => ({
    speaker: u.participantIdentity,
    speakerName: u.displayName,
    speakerRole: u.speakerRole,
    text: u.text,
    startMs: (u.startedAtEpochMs || firstStart) - firstStart,
    endMs: (u.endedAtEpochMs || firstStart) - firstStart,
    confidence: u.confidence ?? null,
  }));
  const lastEnd = rows[rows.length - 1].endedAtEpochMs || firstStart;
  return { utterances, durationMs: lastEnd - firstStart };
}

export async function finalizeSummary({
  meetingId,
  recordingId,
  segmentShortfall = false,
  transcriptVersionId = null,
  transcriptS3Key = null,
  openai: openaiOverride,
} = {}) {
  if (!meetingId) throw new Error('meetingId required');
  const openai = openaiOverride || getOpenai();
  const staleMs = config.ai.finalizeTimeoutMs + 60000;

  const claim = await Recording.findOneAndUpdate(
    buildSummaryClaimFilter({ meetingId, recordingId, staleMs }),
    { $set: { aiProcessingStatus: 'finalizing', summaryClaimedAt: new Date() } },
    { new: true, sort: { _id: -1 } }
  );
  if (!claim) {
    const existing = await Recording.findOne(recordingId ? { _id: recordingId } : { meetingId })
      .sort({ _id: -1 })
      .select('aiProcessingStatus')
      .lean();
    if (!existing) {
      logger.warn('[Finalize] recording not found for claim', { meetingId, recordingId });
      return { skipped: true, reason: 'recording_not_found' };
    }
    if (existing.aiProcessingStatus === 'completed') {
      logger.info('[Finalize] already completed', { meetingId, recordingId });
      return { skipped: true, reason: 'already_completed' };
    }
    // ponytail: a run that outlives the worker timeout loses its lease after timeout + 60 s and may run twice; upgrade path is a lease heartbeat.
    throw new Error('summary lease held by another worker');
  }

  try {
    const v2Session = recordingId
      ? await TranscriptSession.findOne({ recordingId: claim._id }).lean()
      : await TranscriptSession.findOne({ meetingId }).sort({ createdAt: -1 }).lean();

    if (v2Session) {
      let utterances;
      let durationMs;
      let versionS3Key = transcriptS3Key;
      if (transcriptVersionId && !versionS3Key) {
        const TranscriptVersion = (await import('../models/transcriptVersion.model.js')).default;
        const ver = await TranscriptVersion.findById(transcriptVersionId).lean();
        versionS3Key = ver?.s3Key || null;
      }
      if (versionS3Key) {
        const versionDoc = await readJsonFromS3({ key: versionS3Key });
        ({ utterances, durationMs } = utterancesFromTranscriptVersion(versionDoc));
      } else {
        const batches = await TranscriptBatch.find({ sessionId: v2Session._id })
          .sort({ batchSeq: 1 })
          .lean();
        ({ utterances, durationMs } = utterancesFromBatches(batches));
      }
      if (!utterances.length) {
        await Summary.findOneAndUpdate(
          { meetingId },
          {
            $setOnInsert: { meetingId, recordingId: recordingId || claim._id },
            $set: {
              executiveSummary: '[no speech captured]',
              bulletSummary: [],
              partial: true,
              generatedAt: new Date(),
            },
          },
          { upsert: true, new: true }
        );
        await Recording.findByIdAndUpdate(claim._id, {
          aiProcessingStatus: 'completed',
          summaryClaimedAt: null,
        });
        await TranscriptSession.findByIdAndUpdate(v2Session._id, { status: 'completed' });
        return { summaryId: null, version: 1, durationMs: 0, llmCostUsd: 0, partial: true };
      }

      const durationMinutes = Math.round(durationMs / 60000);
      const estTokens = Math.ceil(
        utterances.reduce((c, u) => c + (u.text || '').length, 0) / CHARS_PER_TOKEN
      );
      const gate = applyCostGate({ estTokens, durationMinutes });
      if (!gate.ok) {
        await Recording.findByIdAndUpdate(claim._id, {
          aiProcessingStatus: 'failed',
          aiProcessingError: gate.reason,
          summaryClaimedAt: null,
        });
        await TranscriptSession.findByIdAndUpdate(v2Session._id, { status: 'failed' });
        return { failed: true, reason: gate.reason };
      }

      const transcriptJson = { meetingId, durationMs, utterances };
      const legacyTranscriptKey = `meetings/${meetingId}/transcript.json`;
      const transcriptKey = versionS3Key || legacyTranscriptKey;
      await uploadJsonToS3({
        key: transcriptKey,
        data: transcriptJson,
      });

      const summaryPayload = await mapReduceSummarize({ utterances, durationMs, openai });
      const partial = !!summaryPayload.partial || segmentShortfall || v2Session.partial;

      const prev = await Summary.findOne({ meetingId }).lean();
      const nextVersion = prev ? (prev.version || 1) + 1 : 1;
      const summaryDoc = await Summary.findOneAndUpdate(
        { meetingId },
        {
          $set: {
            recordingId: recordingId || claim._id,
            executiveSummary: summaryPayload.executiveSummary,
            bulletSummary: summaryPayload.bulletSummary,
            actionItems: summaryPayload.actionItems,
            decisions: summaryPayload.decisions,
            blockers: summaryPayload.blockers,
            nextSteps: summaryPayload.nextSteps,
            participantsActive: summaryPayload.participantsActive,
            durationMs,
            llmCostUsd: summaryPayload.llmCostUsd,
            generatedAt: new Date(),
            version: nextVersion,
            partial,
          },
        },
        { upsert: true, new: true }
      );

      const summaryKey = `meetings/${meetingId}/summary.json`;
      await uploadJsonToS3({
        key: summaryKey,
        data: summaryDoc.toObject(),
      });

      const recordingPatch = {
        aiProcessingStatus: 'completed',
        aiProcessingError: null,
        summaryClaimedAt: null,
        summaryId: summaryDoc._id,
        transcriptS3Key: transcriptKey,
        summaryS3Key: summaryKey,
      };
      if (!versionS3Key) {
        recordingPatch.transcriptUrl = `s3://${transcriptKey}`;
        recordingPatch.summaryUrl = `s3://${summaryKey}`;
      }
      await Recording.findByIdAndUpdate(claim._id, recordingPatch);
      await TranscriptSession.findByIdAndUpdate(v2Session._id, { status: 'completed' });

      return {
        summaryId: summaryDoc._id,
        version: nextVersion,
        durationMs,
        llmCostUsd: summaryPayload.llmCostUsd,
        partial,
      };
    }

    const segments = await TranscriptSegment.find({ meetingId }).sort({ sequenceNumber: 1 }).lean();
    if (!segments.length) {
      await Summary.findOneAndUpdate(
        { meetingId },
        {
          $setOnInsert: { meetingId, recordingId: recordingId || claim._id },
          $set: {
            executiveSummary: '[no speech captured]',
            bulletSummary: [],
            partial: true,
            generatedAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );
      await Recording.findByIdAndUpdate(claim._id, {
        aiProcessingStatus: 'completed',
        summaryClaimedAt: null,
      });
      return { summaryId: null, version: 1, durationMs: 0, llmCostUsd: 0, partial: true };
    }

    const utterances = segments.flatMap((s) => s.utterances || []);
    const lastSeg = segments[segments.length - 1];
    const durationMs = lastSeg.windowEndMs;
    const durationMinutes = Math.round(durationMs / 60000);

    const estTokens = estimateTranscriptTokens(segments);
    const gate = applyCostGate({ estTokens, durationMinutes });
    if (!gate.ok) {
      await Recording.findByIdAndUpdate(claim._id, {
        aiProcessingStatus: 'failed',
        aiProcessingError: gate.reason,
        summaryClaimedAt: null,
      });
      logger.warn('[Finalize] cost gate tripped', { meetingId, reason: gate.reason });
      return { failed: true, reason: gate.reason };
    }

    const transcriptJson = buildTranscriptJson(meetingId, segments, durationMs);
    const transcriptUrl = await uploadJsonToS3({
      key: `meetings/${meetingId}/transcript.json`,
      data: transcriptJson,
    });

    const summaryPayload = await mapReduceSummarize({ utterances, durationMs, openai });

    const prev = await Summary.findOne({ meetingId }).lean();
    const nextVersion = prev ? (prev.version || 1) + 1 : 1;
    const summaryDoc = await Summary.findOneAndUpdate(
      { meetingId },
      {
        $set: {
          recordingId: recordingId || claim._id,
          executiveSummary: summaryPayload.executiveSummary,
          bulletSummary: summaryPayload.bulletSummary,
          actionItems: summaryPayload.actionItems,
          decisions: summaryPayload.decisions,
          blockers: summaryPayload.blockers,
          nextSteps: summaryPayload.nextSteps,
          participantsActive: summaryPayload.participantsActive,
          durationMs,
          llmCostUsd: summaryPayload.llmCostUsd,
          generatedAt: new Date(),
          version: nextVersion,
          partial: !!summaryPayload.partial || segmentShortfall,
        },
      },
      { upsert: true, new: true }
    );

    const summaryUrl = await uploadJsonToS3({
      key: `meetings/${meetingId}/summary.json`,
      data: summaryDoc.toObject(),
    });

    const firstSeg = segments[0];
    const partial = !!summaryPayload.partial || segmentShortfall;

    await Recording.findByIdAndUpdate(claim._id, {
      aiProcessingStatus: 'completed',
      aiProcessingError: null,
      summaryClaimedAt: null,
      transcriptId: firstSeg._id,
      summaryId: summaryDoc._id,
      transcriptUrl,
      summaryUrl,
    });

    logger.info('[Finalize] completed', {
      meetingId,
      version: nextVersion,
      llmCostUsd: summaryPayload.llmCostUsd,
      partial,
    });

    return {
      summaryId: summaryDoc._id,
      version: nextVersion,
      durationMs,
      llmCostUsd: summaryPayload.llmCostUsd,
      partial,
    };
  } catch (err) {
    await Recording.findByIdAndUpdate(claim._id, {
      aiProcessingStatus: 'failed',
      aiProcessingError: err.message,
      summaryClaimedAt: null,
    }).catch(() => {});
    throw err;
  }
}
