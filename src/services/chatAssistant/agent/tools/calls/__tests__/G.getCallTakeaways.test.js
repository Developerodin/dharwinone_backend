import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../../../../../config/config.js';
import getCallTakeaways from '../getCallTakeaways.tool.js';
import { checkAccessRule } from '../../../../toolAccess.js';
import { EXTRACT_REQUEST_MS, groundTakeaways, locateQuote } from '../takeaways.js';

const UID = '64b0000000000000000000a1';
const CAND = '64b0000000000000000000c3';

const viewer = (...perms) => ({ id: UID, _id: UID, name: 'Asha', authContext: { permissions: new Set(perms) } });
const FULL = viewer('calls.view', 'call-ai.read', 'call-transcripts.read');
const PLAIN = viewer('calls.view');

const TRANSCRIPT = [
  '[00:40] agent: What salary are you expecting?',
  '[00:52] user: I am expecting 12 LPA.',
  '[01:05] user: My notice period is 30 days and I can join on 1 November.',
  '[01:20] user: I am worried about night shifts.',
  '[01:33] user: I also have an offer from Apollo.',
  '[01:48] user: Can you call me back tomorrow?',
  '[02:02] user: I am declining because the shift is too late.',
  '[02:15] user: I will need visa sponsorship.',
  '[02:30] user: Is the role remote?',
  '[02:40] user: Please email me the job description.',
].join('\n');

const MODEL = {
  expectedSalary: { quote: 'I am expecting 12 LPA.', timestamp: '09:99' },
  noticePeriod: { quote: 'My notice period is 30 days', timestamp: null },
  joiningDate: { quote: 'I can join on 1 November', timestamp: '99:99' },
  questions: [
    { quote: 'What salary are you expecting?', timestamp: '00:01' },
    { quote: 'Is the role remote?', timestamp: null },
    { quote: 'a question nobody asked', timestamp: '03:00' },
  ],
  concerns: [{ quote: 'I am worried about night shifts.', timestamp: '00:00' }],
  otherOffers: [{ quote: 'I also have an offer from Apollo.', timestamp: null }],
  callbackRequest: { quote: 'Can you call me back tomorrow?', timestamp: '08:00' },
  whyDeclined: { quote: 'I am declining because the shift is too late.', timestamp: null },
  visa: { quote: 'I will need visa sponsorship.', timestamp: null },
  followUps: [{ quote: 'Please email me the job description.', timestamp: null }],
};

function doc(over = {}) {
  return {
    executionId: 'exec-1',
    createdAt: new Date('2026-09-10T06:00:00.000Z'),
    completedAt: new Date('2026-09-10T06:05:00.000Z'),
    businessName: 'Priya Shah',
    candidate: CAND,
    purpose: 'job_application_verification',
    transcript: TRANSCRIPT,
    ...over,
  };
}

function callRecord(findOne) {
  return {
    findOne,
    updateOne: () => { throw new Error('must not write'); },
    findOneAndUpdate: () => { throw new Error('must not write'); },
    create: () => { throw new Error('must not write'); },
  };
}

function fakeAi(payload, calls = []) {
  return {
    chat: {
      completions: {
        create: async (body, opts) => {
          calls.push({ body, opts });
          if (payload instanceof Error) throw payload;
          const content = typeof payload === 'function' ? payload(body) : payload;
          return {
            choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
          };
        },
      },
    },
  };
}

function ctx(user, deps = {}, record = doc()) {
  return {
    user,
    requestId: 'r',
    deps: {
      userIsAdmin: async () => false,
      getCallRecordScopeFields: async () => ({ job: null, candidate: CAND, createdBy: UID }),
      userCanAccessCallRecord: async () => true,
      CallRecord: callRecord((q) => ({ lean: async () => (q.executionId === record?.executionId ? record : null) })),
      ...deps,
    },
  };
}

describe('get_call_takeaways', () => {
  it('is gated like get_call_record (calls.view) and budgets 15000ms', async () => {
    assert.equal(getCallTakeaways.timeoutMs, 15000);
    assert.equal(EXTRACT_REQUEST_MS, 14000);
    assert.equal((await checkAccessRule(getCallTakeaways.access, viewer('jobs.read'))).ok, false);
    assert.equal((await checkAccessRule(getCallTakeaways.access, PLAIN)).ok, true);
    assert.equal((await checkAccessRule(getCallTakeaways.access, viewer('calling.manage'))).ok, true);
  });

  it('fails closed without a user id', async () => {
    await assert.rejects(getCallTakeaways.execute({ call: 'exec-1' }, { deps: {} }), /user with an id/);
  });

  it('needs a call id or a name', async () => {
    await assert.rejects(getCallTakeaways.execute({}, ctx(FULL)), /call id or the person/);
  });

  it('returns each takeaway with the transcript quote, the line timestamp, and who said it', async () => {
    const seen = [];
    const out = await getCallTakeaways.execute(
      { call: 'exec-1' },
      ctx(FULL, { openai: fakeAi(MODEL, seen) }),
    );
    const t = out.takeaways;
    assert.equal(out.call.person, 'Priya Shah');
    assert.equal(t.expectedSalary.quote, 'I am expecting 12 LPA.');
    assert.equal(t.expectedSalary.timestamp, '00:52');
    assert.equal(t.expectedSalary.statement, 'On 2026-09-10 the candidate said "I am expecting 12 LPA."');
    assert.equal(JSON.stringify(t).includes('09:99'), false);
    assert.equal(t.noticePeriod.timestamp, '01:05');
    assert.equal(t.joiningDate.quote, 'I can join on 1 November');
    assert.equal(t.joiningDate.timestamp, '01:05');
    assert.equal(t.questions[0].statement, 'On 2026-09-10 the agent said "What salary are you expecting?"');
    assert.equal(t.questions[0].timestamp, '00:40');
    assert.equal(t.questions[1].statement, 'On 2026-09-10 the candidate said "Is the role remote?"');
    assert.equal(t.questions.length, 2);
    assert.equal(t.concerns[0].quote, 'I am worried about night shifts.');
    assert.equal(t.otherOffers[0].quote, 'I also have an offer from Apollo.');
    assert.equal(t.callbackRequest.timestamp, '01:48');
    assert.equal(t.whyDeclined.quote, 'I am declining because the shift is too late.');
    assert.equal(t.visa.quote, 'I will need visa sponsorship.');
    assert.equal(t.followUps[0].quote, 'Please email me the job description.');
    assert.match(out.attribution, /not verified facts/);
    assert.equal('transcript' in out, false);
    assert.equal(seen[0].opts.timeout, EXTRACT_REQUEST_MS);
    assert.equal(seen[0].opts.maxRetries, 0);
    assert.equal(seen[0].body.temperature, 0);
    assert.deepEqual(seen[0].body.response_format, { type: 'json_object' });
    assert.equal(seen[0].body.model, config.ai.extractionModel);
    assert.match(seen[0].body.messages[1].content, /I am expecting 12 LPA/);
    assert.deepEqual(getCallTakeaways.render(out), { blocks: [] });
  });

  it('drops a takeaway whose quote is not in the transcript', () => {
    const grounded = groundTakeaways(
      { expectedSalary: { quote: 'twelve lakhs a year', timestamp: '00:52' }, concerns: [] },
      TRANSCRIPT,
      { day: '2026-09-10', fallback: 'the candidate' },
    );
    assert.equal(grounded.expectedSalary, null);
    assert.equal(grounded.concerns, null);
    assert.equal(JSON.stringify(grounded).includes('twelve lakhs'), false);
  });

  it('keeps a real quote and drops an invented timestamp when the line has none', () => {
    const found = locateQuote('user: I am expecting 12 LPA.', 'I am expecting 12 LPA.', 'the candidate');
    assert.equal(found.timestamp, null);
    assert.equal(found.quote, 'I am expecting 12 LPA.');
    const grounded = groundTakeaways(
      { expectedSalary: { quote: 'I am expecting 12 LPA.', timestamp: '00:10' } },
      'user: I am expecting 12 LPA.',
      { day: '2026-09-10', fallback: 'the candidate' },
    );
    assert.equal(grounded.expectedSalary.timestamp, null);
    assert.equal(grounded.expectedSalary.statement, 'On 2026-09-10 the candidate said "I am expecting 12 LPA."');
  });

  it('reads a timestamp off a structured turn and does not call the person a candidate', async () => {
    const record = doc({
      candidate: null,
      purpose: 'vendor_check',
      businessName: 'Northwind',
      transcript: null,
      conversationTranscript: [{ role: 'user', text: 'I am expecting 12 LPA.', startMs: 52000 }],
    });
    const out = await getCallTakeaways.execute(
      { call: 'exec-1' },
      ctx(FULL, {
        openai: fakeAi({ expectedSalary: { quote: 'I am expecting 12 LPA.', timestamp: '09:99' } }),
      }, record),
    );
    assert.equal(out.takeaways.expectedSalary.timestamp, '0:52');
    assert.match(out.takeaways.expectedSalary.statement, /the person called said/);
    assert.equal(out.takeaways.expectedSalary.statement.includes('the candidate'), false);
  });

  it('refuses when a toggle is off, names it, and does not read the transcript', async () => {
    const secret = 'SECRET-PHRASE-NOT-FOR-THE-MODEL';
    const noRead = callRecord(() => { throw new Error('must not read the transcript'); });
    const noModel = fakeAi(() => { throw new Error('must not call the model'); });

    const both = await getCallTakeaways.execute({ call: 'exec-1' }, ctx(PLAIN, { CallRecord: noRead, openai: noModel }));
    assert.equal(both.refused, true);
    assert.match(both.error, /You cannot see call transcripts/);
    assert.match(both.error, /Call Transcripts toggle/);
    assert.match(both.error, /Call AI toggle/);
    assert.deepEqual(both.missingToggles, ['Call Transcripts', 'Call AI']);
    assert.equal(JSON.stringify(both).includes(secret), false);
    assert.equal(getCallTakeaways.render(both), null);

    const aiOnly = viewer('calls.view', 'call-ai.read');
    const transcriptsOff = await getCallTakeaways.execute(
      { call: 'exec-1' },
      ctx(aiOnly, { CallRecord: noRead, openai: noModel }),
    );
    assert.match(transcriptsOff.error, /You cannot see call transcripts/);
    assert.equal(/Call AI toggle/.test(transcriptsOff.error), false);

    const transcriptsOnly = viewer('calls.view', 'call-transcripts.read');
    const aiOff = await getCallTakeaways.execute(
      { call: 'exec-1' },
      ctx(transcriptsOnly, { CallRecord: noRead, openai: noModel }),
    );
    assert.match(aiOff.error, /Call AI toggle is off/);
    assert.equal(/cannot see call transcripts/.test(aiOff.error), false);
  });

  it('hides a call outside the viewer scope before reading it', async () => {
    const out = await getCallTakeaways.execute({ call: 'exec-1' }, ctx(FULL, {
      userCanAccessCallRecord: async (scope, v) => {
        assert.equal(scope.candidate, CAND);
        assert.deepEqual(v, { userId: UID, isAdmin: false });
        return false;
      },
      CallRecord: callRecord(() => { throw new Error('must not read'); }),
      openai: fakeAi(() => { throw new Error('must not call the model'); }),
    }));
    assert.equal(out.forbidden, true);
    assert.match(out.error, /do not have access/);
  });

  it('reports notFound for an unknown id without searching by name', async () => {
    let listed = false;
    const out = await getCallTakeaways.execute({ call: 'missing-id-999' }, ctx(FULL, {
      getCallRecordScopeFields: async () => null,
      listCallRecords: () => { listed = true; return { results: [] }; },
      openai: fakeAi(() => { throw new Error('must not call the model'); }),
    }));
    assert.deepEqual(out, { notFound: true, id: 'missing-id-999' });
    assert.equal(listed, false);
  });

  it('uses the latest visible call when call is a name, in the page scope', async () => {
    const listed = [];
    const out = await getCallTakeaways.execute({ call: 'Priya Shah' }, ctx(FULL, {
      listCallRecords: async (o) => {
        listed.push(o);
        return { results: [{ executionId: 'exec-1', displayName: 'Priya S.' }] };
      },
      openai: fakeAi({ expectedSalary: { quote: 'I am expecting 12 LPA.', timestamp: null } }),
    }));
    assert.equal(listed[0].search, 'Priya Shah');
    assert.equal(listed[0].userId, UID);
    assert.equal(listed[0].limit, 1);
    assert.equal(out.call.person, 'Priya S.');
    assert.equal(out.takeaways.expectedSalary.quote, 'I am expecting 12 LPA.');
  });

  it('matches a candidate profile id exactly, not as page search', async () => {
    const listed = [];
    await getCallTakeaways.execute({ call: CAND }, ctx(FULL, {
      listCallRecords: async (o) => {
        listed.push(o);
        return { results: [] };
      },
    }));
    assert.equal(listed[0].candidateId, CAND);
    assert.equal(listed[0].search, undefined);
  });

  it('returns nulls and does not call the model when the call has no transcript', async () => {
    const out = await getCallTakeaways.execute({ call: 'exec-1' }, ctx(FULL, {
      openai: fakeAi(() => { throw new Error('must not call the model'); }),
    }, doc({ transcript: '  ', conversationTranscript: null })));
    assert.equal(out.transcriptMissing, true);
    assert.equal(out.takeaways.expectedSalary, null);
    assert.equal(out.takeaways.questions, null);
    assert.equal(out.takeaways.concerns, null);
    assert.equal(out.takeaways.otherOffers, null);
  });

  it('does not call the model when the AI service is not configured', async () => {
    const saved = config.openai.apiKey;
    config.openai.apiKey = '';
    try {
      const out = await getCallTakeaways.execute({ call: 'exec-1' }, ctx(FULL));
      assert.match(out.error, /not configured/);
      assert.equal(out.takeaways, undefined);
    } finally {
      config.openai.apiKey = saved;
    }
  });

  it('does not invent takeaways when the model returns nothing usable', async () => {
    const bad = await getCallTakeaways.execute({ call: 'exec-1' }, ctx(FULL, { openai: fakeAi('not-json') }));
    assert.match(bad.error, /Could not read takeaways/);
    assert.equal(bad.takeaways, undefined);
    const thrown = await getCallTakeaways.execute(
      { call: 'exec-1' },
      ctx(FULL, { openai: fakeAi(new Error('timeout')) }),
    );
    assert.match(thrown.error, /Could not read takeaways/);
  });

  it('re-runs the extraction on every ask', async () => {
    const seen = [];
    const deps = { openai: fakeAi(MODEL, seen) };
    await getCallTakeaways.execute({ call: 'exec-1' }, ctx(FULL, deps));
    await getCallTakeaways.execute({ call: 'exec-1' }, ctx(FULL, deps));
    assert.equal(seen.length, 2);
  });

  it('drops a quote that sat past the transcript cap sent to the model', async () => {
    const filler = `${'x'.repeat(12000)}\nuser: I am expecting 12 LPA.`;
    const seen = [];
    const out = await getCallTakeaways.execute({ call: 'exec-1' }, ctx(FULL, {
      openai: fakeAi({ expectedSalary: { quote: 'I am expecting 12 LPA.', timestamp: '00:52' } }, seen),
    }, doc({ transcript: filler })));
    assert.equal(out.transcriptTruncated, true);
    assert.equal(out.takeaways.expectedSalary, null);
    assert.equal(seen[0].body.messages[1].content.includes('12 LPA'), false);
  });
});
