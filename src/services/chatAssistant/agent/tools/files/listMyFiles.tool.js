import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { FILES_ACCESS, LIST_LIMIT, callerId, filesDeps, folderIsUnsafe, toFileList } from './common.js';

export default defineTool({
  name: 'list_my_files',
  domain: 'files',
  kind: 'read',
  description:
    'List the signed-in user\'s own File Storage (Communication → File Storage). Use for "my files", ' +
    '"what did I upload", "files in the Projects folder", "find a file named BRD", "what was uploaded ' +
    'recently". search matches stored file and folder names only, never words inside a file. Returns ' +
    'name, folder, size, last modified, and uploader when S3 recorded it. Never another person\'s files, ' +
    'and never the file\'s contents.',
  measure:
    'Files in the signed-in user\'s own File Storage (S3 prefix file-storage/{their user id}/ only). ' +
    'One folder level unless search is set. Not other people\'s files.',
  input: Joi.object({
    folder: Joi.string().max(500).description('Folder path inside your File Storage, such as Projects or Projects/Specs.'),
    search: Joi.string().min(2).max(200).description('Part of a file or folder name. Not a search of file contents.'),
    limit: Joi.number().integer().min(1).max(LIST_LIMIT).default(LIST_LIMIT)
      .description('How many files to return (max 50).'),
  }),
  access: FILES_ACCESS,
  timeoutMs: 15000,
  async execute({ folder, search, limit } = {}, ctx) {
    const userId = callerId(ctx);
    if (folderIsUnsafe(folder)) {
      return {
        ok: false,
        refused: true,
        scope: 'self',
        total: 0,
        files: [],
        folders: [],
        truncated: false,
        reason: 'That folder path is not allowed.',
      };
    }
    const term = typeof search === 'string' ? search.trim() : '';
    const maxKeys = Math.min(Number(limit) || LIST_LIMIT, LIST_LIMIT);
    const { listObjects, headObject } = filesDeps(ctx);
    const listed = await listObjects(userId, folder || '', {
      ...(term.length >= 2 ? { search: term } : {}),
      maxKeys,
    });
    const { files, folders } = await toFileList(listed, userId, headObject);
    return {
      ok: true,
      scope: 'self',
      total: files.length,
      files,
      folders,
      truncated: listed?.isTruncated === true,
      filtersApplied: {
        folder: folder ? String(folder) : null,
        search: term.length >= 2 ? term : null,
      },
    };
  },
});
