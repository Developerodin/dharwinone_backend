import requestDocuments from './requestDocuments.tool.js';
import remindPendingDocuments from './remindPendingDocuments.tool.js';

export const instructions = [
  'Document requests: "ask / request <documents> from <person>" → request_documents with that one person and ' +
    'each document as { label, type?, notes? }. "remind <person> about their pending documents" → ' +
    'remind_pending_documents. Both only draft; say the request or reminder is ready to review and confirm, ' +
    'never that it was sent.',
  '- One person per call, named by the user; never draft for a group ("everyone in pre-boarding"). For several ' +
    'people, ask the user to name them one at a time.',
  '- Which documents someone has, is missing or has pending is a question, not an action: use list_documents.',
].join('\n');

export const tools = [requestDocuments, remindPendingDocuments];
