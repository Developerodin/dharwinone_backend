import test, { mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let parseResumeForPublicApplyStream;
let readCompletedJsonString;
let readCompletedSkillNames;

/** Text the PDF layer yields; '' sends the parse down the unreadable-file path instead. */
let textLayer = 'Harsh Bansal\nharsh@example.com\n\nSKILLS\nReact';
/** Set when the model call should reject. */
let streamError = null;

/**
 * The model's JSON reply, in the prompt's key order. Deliberately includes a certification and a
 * project, both of which carry a `name` key and must NOT be streamed as skills.
 */
const REPLY = JSON.stringify({
  fullName: 'Harsh Bansal',
  email: 'harsh@example.com',
  countryCode: 'IN',
  phone: '+917742749850',
  technical: [{ name: 'React', level: 'Advanced' }],
  tools: [{ name: 'Figma', level: 'Intermediate' }],
  certifications: [{ name: 'AWS Certified Solutions Architect' }],
  experiences: [
    { company: 'Acme Corp', role: 'Senior Engineer' },
    { company: 'Globex Inc', role: 'Engineer' },
  ],
  qualifications: [{ degree: 'B.Tech', institute: 'IIT Delhi' }],
  projects: [{ name: 'Chat App', description: 'Realtime messaging' }],
  socialLinks: [{ platform: 'LinkedIn', url: 'https://linkedin.com/in/harsh' }],
});

/** Split into small pieces so values land mid-chunk, as real token deltas do. */
function* replyChunks() {
  for (let i = 0; i < REPLY.length; i += 7) {
    yield { model: 'gpt-4o-mini', choices: [{ delta: { content: REPLY.slice(i, i + 7) } }] };
  }
}

before(async () => {
  mock.module('../documentExtraction.service.js', {
    namedExports: {
      extractRawTextFromFile: async () => textLayer,
      getPdfPageCount: async () => 1,
    },
  });

  mock.module('../moduleOpenAI.service.js', {
    namedExports: { parseJsonWithRepair: (raw) => JSON.parse(raw) },
  });

  mock.module('../../config/config.js', {
    defaultExport: { openai: { apiKey: 'test-key' } },
  });

  mock.module('openai', {
    defaultExport: class OpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async (payload) => {
              // The vision fallback also calls create (buffered, no response_format) when the
              // file has no text layer, so only the JSON-mode parse call is asserted here.
              if (!payload.response_format) {
                return { model: 'gpt-4o-mini', choices: [{ message: { content: '' } }] };
              }
              if (streamError) throw new Error(streamError);
              assert.equal(payload.stream, true, 'the parse call must request a streamed completion');
              return (async function* iterate() {
                for (const chunk of replyChunks()) yield chunk;
              })();
            },
          },
        };
      }
    },
  });

  const mod = await import('../resumeSkillsExtract.service.js');
  parseResumeForPublicApplyStream = mod.parseResumeForPublicApplyStream;
  readCompletedJsonString = mod.readCompletedJsonString;
  readCompletedSkillNames = mod.readCompletedSkillNames;
});

after(() => {
  mock.reset();
});

beforeEach(() => {
  textLayer = 'Harsh Bansal\nharsh@example.com\n\nSKILLS\nReact';
  streamError = null;
});

async function collectEvents() {
  const events = [];
  await parseResumeForPublicApplyStream(
    Buffer.from('%PDF-1.4'),
    'application/pdf',
    'resume.pdf',
    (e) => events.push(e)
  );
  return events;
}

test('readCompletedJsonString withholds a value until its closing quote arrives', () => {
  assert.equal(readCompletedJsonString('{"fullName": "Harsh Bans', 'fullName'), null);
  assert.equal(readCompletedJsonString('{"fullName": "Harsh Bansal",', 'fullName'), 'Harsh Bansal');
});

test('readCompletedSkillNames excludes certifications and projects', () => {
  assert.deepEqual(readCompletedSkillNames(REPLY), ['React', 'Figma']);
});

test('streams stages, then fields, then one authoritative result', async () => {
  const events = await collectEvents();

  // Extraction then the model call come first; the per-section stages are covered separately.
  assert.deepEqual(
    events
      .filter((e) => e.type === 'stage')
      .map((e) => e.stage)
      .slice(0, 2),
    ['extracting', 'reading']
  );

  const fields = events.filter((e) => e.type === 'field');
  assert.deepEqual(
    fields.map((e) => [e.field, e.value]),
    [
      ['fullName', 'Harsh Bansal'],
      ['email', 'harsh@example.com'],
      ['countryCode', 'IN'],
      // countryCode arrives first, so the dial prefix is stripped in the preview too.
      ['phoneNumber', '7742749850'],
    ]
  );

  // Each field announced exactly once, however many chunks it spanned.
  assert.equal(new Set(fields.map((e) => e.field)).size, fields.length);

  const results = events.filter((e) => e.type === 'result');
  assert.equal(results.length, 1, 'exactly one result event');
  assert.equal(results[0].status, 'success');
  assert.equal(events[events.length - 1].type, 'result', 'result must be last');
});

test('streamed skills match the final result and never include a certification', async () => {
  const events = await collectEvents();

  const streamedSkills = events.filter((e) => e.type === 'skill').map((e) => e.name);
  const finalSkills = events.find((e) => e.type === 'result').fields.skills.map((s) => s.name);

  assert.deepEqual(streamedSkills, ['React', 'Figma']);
  assert.deepEqual(finalSkills, ['React', 'Figma']);
  assert.ok(!streamedSkills.includes('AWS Certified Solutions Architect'));
});

test('a model failure still ends with a failed result, never a half-applied form', async () => {
  streamError = 'upstream exploded';
  const events = await collectEvents();

  assert.equal(events.filter((e) => e.type === 'field').length, 0);
  const result = events[events.length - 1];
  assert.equal(result.type, 'result');
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.fields.skills, []);
});

test('an unreadable file fails before any model call', async () => {
  textLayer = '';
  const events = await collectEvents();

  const result = events[events.length - 1];
  assert.equal(result.type, 'result');
  assert.equal(result.status, 'failed');
  assert.match(result.warnings.join(' '), /couldn't read any text/i);
});

test('reports progress through experience, education and links, not just skills', async () => {
  const events = await collectEvents();

  // Every section announces itself, so the UI never sits on the last skill looking stuck.
  assert.deepEqual(
    events.filter((e) => e.type === 'stage').map((e) => e.stage),
    ['extracting', 'reading', 'experiences', 'qualifications', 'socialLinks']
  );

  const items = events.filter((e) => e.type === 'item');
  assert.deepEqual(
    items.map((e) => [e.section, e.label]),
    [
      ['experiences', 'Acme Corp'],
      ['experiences', 'Globex Inc'],
      ['qualifications', 'IIT Delhi'],
      ['socialLinks', 'LinkedIn'],
    ]
  );

  // Each entry announced exactly once however many chunks it spanned.
  assert.equal(new Set(items.map((e) => `${e.section}:${e.label}`)).size, items.length);

  const result = events[events.length - 1];
  assert.equal(result.type, 'result');
  assert.equal(result.fields.experiences.length, 2);
  assert.equal(result.fields.qualifications.length, 1);
  assert.equal(result.fields.socialLinks.length, 1);
});
