import test, { mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let parseResumeForPublicApply;
let normalizeResumeText;

/** Text the PDF text layer yields — '' stands for a scan with no text layer at all. */
let textLayer = '';
/** Page count reported for the uploaded PDF. */
let pageCount = 1;
/** Every payload handed to chat.completions.create, in order. */
let calls = [];

const TRANSCRIPT = ['Jane Doe', 'jane.doe@example.com', '+1 5551234567', '', 'SKILLS', 'JavaScript', 'React'].join(
  '\n'
);

const PROFILE_JSON = JSON.stringify({
  fullName: 'Jane Doe',
  email: 'jane.doe@example.com',
  phone: '5551234567',
  countryCode: 'US',
  technical: [{ name: 'JavaScript', level: 'Advanced' }],
  tools: [{ name: 'React', level: 'Advanced' }],
  certifications: [{ name: 'AWS Certified Solutions Architect' }],
  experiences: [],
  qualifications: [],
  projects: [{ name: 'Chat App', description: 'Realtime messaging' }],
  socialLinks: [],
});

before(async () => {
  mock.module('../documentExtraction.service.js', {
    namedExports: {
      extractRawTextFromFile: async () => textLayer,
      getPdfPageCount: async () => pageCount,
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
              calls.push(payload);
              // The transcription call sends the file; the extraction call asks for JSON.
              const isTranscribe = payload.response_format == null;
              return {
                model: 'gpt-4o-mini',
                choices: [{ message: { content: isTranscribe ? TRANSCRIPT : PROFILE_JSON } }],
              };
            },
          },
        };
      }
    },
  });

  const mod = await import('../resumeSkillsExtract.service.js');
  parseResumeForPublicApply = mod.parseResumeForPublicApply;
  normalizeResumeText = mod.normalizeResumeText;
});

after(() => {
  mock.reset();
});

beforeEach(() => {
  textLayer = '';
  pageCount = 1;
  calls = [];
});

test('a PDF with no text layer is transcribed by the model, then parsed', async () => {
  const result = await parseResumeForPublicApply(Buffer.from('%PDF-1.4 scan'), 'application/pdf', 'scan.pdf');

  assert.equal(calls.length, 2, 'expected a transcription call and an extraction call');

  const [transcribe, extract] = calls;
  const filePart = transcribe.messages[1].content.find((c) => c.type === 'file');
  assert.ok(filePart, 'transcription call must send the PDF as a file content part');
  assert.match(filePart.file.file_data, /^data:application\/pdf;base64,/);
  assert.equal(filePart.file.filename, 'scan.pdf');
  assert.equal(transcribe.temperature, 0);

  assert.deepEqual(extract.response_format, { type: 'json_object' });
  assert.ok(extract.messages[1].content.includes('SKILLS'), 'transcript must feed the extraction prompt');

  assert.equal(result.status, 'success');
  assert.equal(result.fields.fullName, 'Jane Doe');
  assert.deepEqual(
    result.fields.skills.map((s) => s.name),
    ['JavaScript', 'React'],
    'certifications must not appear as skills'
  );
});

test('a PDF that already has a text layer never reaches the vision fallback', async () => {
  textLayer = [
    'Jane Doe',
    'jane.doe@example.com',
    '+1 5551234567',
    '',
    'SKILLS',
    'JavaScript, React, Node.js, five years building web apps.',
  ].join('\n');

  const result = await parseResumeForPublicApply(Buffer.from('%PDF-1.4'), 'application/pdf', 'resume.pdf');

  assert.equal(calls.length, 1, 'text-layer PDFs must cost exactly one API call');
  assert.deepEqual(calls[0].response_format, { type: 'json_object' });
  assert.equal(result.status, 'success');
});

test('the fallback is skipped when the PDF exceeds the page cap', async () => {
  pageCount = 50;

  const result = await parseResumeForPublicApply(Buffer.from('%PDF-1.4 big'), 'application/pdf', 'big.pdf');

  assert.equal(calls.length, 0, 'no model call may be made for an oversized scan');
  assert.equal(result.status, 'failed');
  assert.match(result.warnings.join(' '), /couldn't read any text/i);
});

test('a DOCX with no readable text fails without a vision call', async () => {
  const result = await parseResumeForPublicApply(
    Buffer.from('PK'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'resume.docx'
  );

  assert.equal(calls.length, 0, 'the fallback is PDF-only');
  assert.equal(result.status, 'failed');
});

test('normalizeResumeText keeps line breaks and collapses only intra-line runs', () => {
  const out = normalizeResumeText('SKILLS\r\n  React    Node.js  \n\n\n\nEDUCATION');
  assert.equal(out, 'SKILLS\nReact Node.js\n\nEDUCATION');
});
