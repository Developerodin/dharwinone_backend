// uat.dharwin.backend/src/services/chatAssistant/temporalContext.js
//
// Resolve relative dates ("yesterday", "today", "last Friday") and topic
// hints ("attendance", "leaves") against the current turn AND the prior
// memory state, so follow-ups like "was he present yesterday" carry both
// the person AND the day forward via ConversationMemory.lastEntities.

const RELATIVE_DATE_RE = /\b(today|yesterday|tomorrow|day before yesterday|this week|last week|this month|last month)\b/i;
const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const TOPIC_RE = /\b(attendance|punch|present|absent|leave|leaves|leave request|backdated|profile|overview|shift|week off|holidays|projects?|tasks?|jobs?|candidates?|offers?|placements?)\b/i;

/**
 * Extract date + topic hints from a turn of user text.
 * Returns a partial of ConversationMemory.lastEntities — only fields the text
 * mentioned. Caller merges with prior memory so unmentioned fields persist.
 *
 * @param {string} text
 * @param {Date} [now=new Date()]
 * @returns {{ lastDate?: string, lastDateLabel?: string, lastTopic?: string }}
 */
export function extractTemporalContext(text, now = new Date()) {
  if (!text) return {};
  const out = {};

  const iso = text.match(ISO_DATE_RE);
  if (iso) {
    out.lastDate = iso[1];
    out.lastDateLabel = iso[1];
  }

  const rel = text.match(RELATIVE_DATE_RE);
  if (rel) {
    const label = rel[1].toLowerCase();
    out.lastDateLabel = label;
    const d = new Date(now);
    if (label === 'today') {
      out.lastDate = d.toISOString().slice(0, 10);
    } else if (label === 'yesterday') {
      d.setUTCDate(d.getUTCDate() - 1);
      out.lastDate = d.toISOString().slice(0, 10);
    } else if (label === 'tomorrow') {
      d.setUTCDate(d.getUTCDate() + 1);
      out.lastDate = d.toISOString().slice(0, 10);
    } else if (label === 'day before yesterday') {
      d.setUTCDate(d.getUTCDate() - 2);
      out.lastDate = d.toISOString().slice(0, 10);
    }
    // "this week" / "last week" / "this month" / "last month" intentionally
    // leave lastDate empty — they are ranges, surfaced via lastDateLabel only.
  }

  const topic = text.match(TOPIC_RE);
  if (topic) {
    const t = topic[1].toLowerCase();
    if (/leave/.test(t)) out.lastTopic = 'leave';
    else if (/attendance|punch|present|absent/.test(t)) out.lastTopic = 'attendance';
    else if (/profile|overview|shift|week off|holidays/.test(t)) out.lastTopic = 'profile';
    else if (/backdated/.test(t)) out.lastTopic = 'backdated';
    else if (/project/.test(t)) out.lastTopic = 'project';
    else if (/task/.test(t)) out.lastTopic = 'task';
    else out.lastTopic = t;
  }

  return out;
}
