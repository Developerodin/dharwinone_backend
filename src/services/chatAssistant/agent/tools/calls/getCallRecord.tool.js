import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { CALLS_ACCESS, callsScope, callsDeps, runCallGet } from './common.js';

export default defineTool({
  name: 'get_call_record',
  domain: 'calls',
  kind: 'read',
  description:
    'One call in detail, by call id (the id from list_call_records) or as "the latest call with <person>": ' +
    'the call row plus the AI summary and AI-extracted answers (interest, location, availability, outcome) as ' +
    'attributed statements — only with the Call AI toggle; the transcript only with the Call Transcripts ' +
    'toggle; recording playback links only with the Call Recording toggle. Use for "what did Priya say on ' +
    'her last call", "summary of call <id>", "is there a recording of the call with Rahul", "who hung up". ' +
    'hangupBy / hangupReason come from the telephony provider on AI agent calls only. Salary, joining ' +
    'date, questions, concerns and other offers are not captured in DharwinOne.',
  input: Joi.object({
    id: Joi.string().min(1).max(100).description('Call id (execution id) from list_call_records.'),
    person: Joi.string().min(2).max(100)
      .description('Name or phone number (or candidate profile id) — returns the latest call with them. Used when id is omitted.'),
  }),
  access: CALLS_ACCESS,
  async execute({ id, person } = {}, ctx) {
    const user = callsScope(ctx);
    if (!String(id ?? '').trim() && !String(person ?? '').trim()) {
      throw new Error('Give either id or person.');
    }
    return runCallGet({ id, person, user, deps: callsDeps(ctx) });
  },
  render(result) {
    if (!result || result.error || !result.call) return null;
    return { blocks: [] };
  },
});
