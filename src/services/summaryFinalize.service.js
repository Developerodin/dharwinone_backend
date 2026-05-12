import OpenAI from 'openai';
import config from '../config/config.js';
import { costForUsage } from '../config/llmPricing.js';
import TranscriptSegment from '../models/transcriptSegment.model.js';
import Summary from '../models/summary.model.js';
import Recording from '../models/recording.model.js';
import logger from '../config/logger.js';
import { uploadJsonToS3 } from './aiArtifactStorage.service.js';

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

export async function finalizeSummary({ meetingId, recordingId, openai: openaiOverride } = {}) {
  if (!meetingId) throw new Error('meetingId required');
  const openai = openaiOverride || getOpenai();

  const claim = await Recording.findOneAndUpdate(
    { meetingId, aiProcessingStatus: { $nin: ['finalizing', 'completed'] } },
    { $set: { aiProcessingStatus: 'finalizing', finalizingAt: new Date() } },
    { new: true }
  );
  if (!claim) {
    logger.info('[Finalize] another worker already finalizing or already completed', { meetingId });
    return { skipped: true };
  }

  try {
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
      await Recording.findByIdAndUpdate(claim._id, { aiProcessingStatus: 'completed' });
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
          partial: !!summaryPayload.partial,
        },
      },
      { upsert: true, new: true }
    );

    const summaryUrl = await uploadJsonToS3({
      key: `meetings/${meetingId}/summary.json`,
      data: summaryDoc.toObject(),
    });

    const firstSeg = segments[0];
    await Recording.findByIdAndUpdate(claim._id, {
      aiProcessingStatus: 'completed',
      aiProcessingError: null,
      transcriptId: firstSeg._id,
      summaryId: summaryDoc._id,
      transcriptUrl,
      summaryUrl,
    });

    logger.info('[Finalize] completed', {
      meetingId,
      version: nextVersion,
      llmCostUsd: summaryPayload.llmCostUsd,
      partial: summaryPayload.partial,
    });

    return {
      summaryId: summaryDoc._id,
      version: nextVersion,
      durationMs,
      llmCostUsd: summaryPayload.llmCostUsd,
      partial: !!summaryPayload.partial,
    };
  } catch (err) {
    await Recording.findByIdAndUpdate(claim._id, {
      aiProcessingStatus: 'failed',
      aiProcessingError: err.message,
    }).catch(() => {});
    throw err;
  }
}
