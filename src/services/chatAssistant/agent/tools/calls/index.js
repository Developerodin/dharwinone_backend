import countCallRecords from './countCallRecords.tool.js';
import listCallRecords from './listCallRecords.tool.js';
import getCallRecord from './getCallRecord.tool.js';
import getCallTakeaways from './getCallTakeaways.tool.js';
import getCallMetrics from './getCallMetrics.tool.js';
import listCallFollowups from './listCallFollowups.tool.js';

const summary = 'Calls: counts, lists, one call, salary/notice/concerns/offers quoted from the transcript, answer rates, callbacks';

const instructions = [
  'Calls: phone call records from Communication → Call Records (Bolna AI verification calls and Twilio / Plivo ' +
    'dialer calls). Rows are the page\'s own scope: Administrators see every call, everyone else sees calls they ' +
    'placed or on jobs / candidates they own.',
  '- "How many calls" → count_call_records (groupBy "status", "day", "caller" or "hangupBy" for a breakdown; "who made ' +
    'the most calls" is groupBy "caller"). "Show / which calls" → list_call_records. One call\'s details, "what did X ' +
    'say", a summary, transcript, recording or who hung up → get_call_record (id from a list, or person for their latest call).',
  '- Expected salary, notice period, joining date, questions asked, concerns, other offers, a callback asked for ' +
    'on that call, why they declined, a visa mention, or another follow-up they stated → get_call_takeaways ' +
    '(call id, or the person\'s name for their latest call). Each item includes the quote it came from and that ' +
    'line\'s timestamp; null means it was not said. A takeaway without a quote is not an answer. Say "the candidate ' +
    'said" (or "the agent said" when the statement says so) and quote it — never as a verified fact. Do not answer ' +
    'these from get_call_record. If the result says the caller cannot see transcripts, or names the Call Transcripts ' +
    'or Call AI toggle, say that. Not semantic search and not topic clustering.',
  '- Answer rate, average duration, failed count, interest-confirmed rate, how many applicants are not yet called, ' +
    'how many callbacks are due / overdue → get_call_metrics with calledBetween.',
  '- WHO asked for a callback / whose callback is overdue / which applicants were never called → list_call_followups ' +
    '(kind callbackRequested / callbackOverdue / notYetCalled; jobId or appliedBetween to narrow).',
  '- A day or range ("today", "last week", "in September") → filters.calledBetween (YYYY-MM-DD, IST). "My calls" → ' +
    'filters.mine true. A person\'s name or phone → filters.person. "Missed" → status "missed".',
  '- AI summary and extracted answers are attributed statements ("On <date> the candidate said …"), never facts. ' +
    'Say "the AI noted" or quote them; do not restate them as verified.',
  '- aiFieldsHidden / transcriptHidden / recordingsHidden mean the user\'s role lacks the Call AI / Call Transcripts / ' +
    'Call Recording toggle; applicantMetricsHidden means no Applications page access — say that, do not say the data is missing.',
  '- unclassifiedCalls = older calls with no call type that match every other filter; with a callType filter, say ' +
    'those are not included.',
  '- Not captured in DharwinOne: per-call attempt number, and who hung up on dialer calls — say so instead of estimating. ' +
    'Salary, notice period, joining date, questions, concerns, other offers, why they declined, a visa mention and ' +
    'a callback they asked for on the call are captured only as transcript quotes from get_call_takeaways. If that ' +
    'call has no transcript, those are not captured for that call.',
  '- Not for semantic search over transcripts, interviews (hiring) or internal meetings (meetings).',
].join('\n');

export default {
  domain: 'calls',
  summary,
  instructions,
  tools: [countCallRecords, listCallRecords, getCallRecord, getCallTakeaways, getCallMetrics, listCallFollowups],
};
