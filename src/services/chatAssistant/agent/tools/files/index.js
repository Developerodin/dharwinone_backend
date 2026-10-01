import getFileLink from './getFileLink.tool.js';
import listMyFiles from './listMyFiles.tool.js';

const instructions = [
  'File Storage: the signed-in user\'s own files only (Communication → File Storage). Never list or link another person\'s files.',
  '- "My files", "what did I upload", "files in a folder", "find a file named …" → list_my_files. ' +
    'search matches stored file and folder names only (the File Storage search), not words inside a file. ' +
    'folder is a path such as Projects, not someone else\'s storage.',
  '- A listed file\'s name is the stored name the page shows. originalName and uploadedBy come from S3 ' +
    'metadata when the upload recorded them; null means not recorded. uploadedBy is that account id, not a ' +
    'person\'s name — do not invent a name, and do not guess the uploader is the caller.',
  '- lastModified null means not recorded. "Uploaded today" and "recent uploads" use lastModified on the ' +
    'rows returned. The list is one folder level unless search is set. truncated true means more files ' +
    'exist — say the list may be incomplete. There is no upload-date filter.',
  '- A download link → get_file_link with the key from list_my_files. The link lasts about 10 minutes. ' +
    'A refusal means that key is not in this user\'s File Storage. Do not retry with another person\'s id.',
  '- Do not summarize, quote, or compare what is inside a file. This chat does not read file contents.',
  '- Search inside file contents, older versions, and who else can open a file are not captured in ' +
    'DharwinOne. There is no per-file sharing history.',
].join('\n');

export default {
  domain: 'files',
  summary: 'Your File Storage: list, search by name, recent uploads, download link',
  instructions,
  tools: [listMyFiles, getFileLink],
};
