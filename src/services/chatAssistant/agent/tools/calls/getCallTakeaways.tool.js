import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { CALLS_ACCESS, callsScope, callsDeps } from './common.js';
import { runCallTakeaways } from './takeaways.js';

// 15000 is defineTool's ceiling. 20000 is the model-step timeout and is rejected at load.
const TOOL_TIMEOUT_MS = 15000;

export default defineTool({
  name: 'get_call_takeaways',
  domain: 'calls',
  kind: 'read',
  description:
    'Takeaways from one call\'s transcript, each with the quote it came from and that line\'s timestamp: ' +
    'expected salary, notice period, joining date, questions asked, concerns, other offers, a callback ' +
    'request, why they declined, a visa mention, and other follow-ups they asked for. Anything not said ' +
    'is null. The result includes the transcript when one was loaded (transcriptAvailable). A null field means ' +
    'the extractor returned null, not that the words are absent and not that the transcript is missing — read ' +
    '`transcript` before answering, and do not invent a quote. Say absent only when the words are not in the ' +
    'transcript. A takeaway without a quote from the transcript is not an answer. Wording is attributed ' +
    '("the candidate said" or "the agent said"), never a verified fact. Use for "what salary did Priya ' +
    'mention", "what notice period did he give", "what concerns did she raise", "did he mention another ' +
    'offer", "what questions were asked", "when can they join", "why did they decline on the call", ' +
    '"did she ask for a callback on the call", "did they mention a visa". call is the call id from ' +
    'list_call_records, or the person\'s name or phone for their latest call. Needs calls.view plus the ' +
    'Call Transcripts and Call AI toggles; if either is off the result names that toggle and does not ' +
    'return a transcript. Not semantic search over transcripts, not topic clustering, not the booked ' +
    'callback list (list_call_followups), and not the AI summary (get_call_record).',
  input: Joi.object({
    call: Joi.string().trim().min(1).max(200).required()
      .description('Call id from list_call_records, or the person\'s name or phone for their latest call.'),
  }),
  access: CALLS_ACCESS,
  timeoutMs: TOOL_TIMEOUT_MS,
  async execute({ call } = {}, ctx) {
    const user = callsScope(ctx);
    // callsDeps only forwards the call-record seam. The OpenAI client is a test override.
    return runCallTakeaways({ call, user, deps: { ...callsDeps(ctx), openai: ctx?.deps?.openai } });
  },
  render(result) {
    if (!result || result.error || result.refused || result.notFound || result.forbidden || !result.call) return null;
    return { blocks: [] };
  },
});
