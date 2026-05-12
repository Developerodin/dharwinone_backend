import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapReduceSummarize } from '../summaryFinalize.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('mapReduceSummarize on fixture produces shape (mocked openai)', async () => {
  const fixture = JSON.parse(
    await fs.readFile(path.join(__dirname, 'fixtures/short-meeting.json'), 'utf8')
  );
  const fakeOpenai = {
    chat: {
      completions: {
        create: async ({ messages, model }) => {
          const system = messages[0]?.content || '';
          if (system.includes('Summarize this meeting segment')) {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      windowSummary: 'They discussed Python agent runtime.',
                      windowBullets: ['Picked Python.', 'Alice writes spec.'],
                      actionCandidates: [{ text: 'Alice writes spec', owner: 'u_alice', timestampMs: 6100 }],
                      decisionCandidates: [{ text: 'Use Python agent runtime', timestampMs: 1000 }],
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 200, completion_tokens: 100 },
              model,
            };
          }
          if (system.includes('Combine these segment summaries')) {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      executiveSummary: 'Team picked Python agent runtime; Alice owns the spec.',
                      bulletSummary: ['Decided on Python', 'Action: Alice writes spec'],
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 50 },
              model,
            };
          }
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    actionItems: [{ text: 'Alice writes spec', owner: 'u_alice', timestampMs: 6100 }],
                    decisions: [{ text: 'Use Python agent runtime', timestampMs: 1000 }],
                    blockers: ['Deepgram API key missing'],
                    nextSteps: [],
                    participantsActive: [{ identity: 'u_alice', name: 'Alice', speakingMs: 11000 }],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 200, completion_tokens: 100 },
            model,
          };
        },
      },
    },
  };
  const out = await mapReduceSummarize({
    utterances: fixture.utterances,
    durationMs: fixture.durationMs,
    openai: fakeOpenai,
  });
  assert.equal(typeof out.executiveSummary, 'string');
  assert.ok(Array.isArray(out.bulletSummary));
  assert.ok(Array.isArray(out.actionItems));
  assert.ok(Array.isArray(out.decisions));
  assert.ok(out.llmCostUsd > 0);
});
