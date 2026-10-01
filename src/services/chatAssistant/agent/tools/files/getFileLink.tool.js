import Joi from 'joi';
import httpStatus from 'http-status';
import { isKeyAllowed } from '../../../../fileStorage.service.js';
import { defineTool } from '../../defineTool.js';
import { FILES_ACCESS, callerId, filesDeps } from './common.js';

const REFUSED = Object.freeze({
  ok: false,
  refused: true,
  url: null,
  reason: 'That file is not in your File Storage.',
});

function isForbidden(err) {
  return err?.statusCode === httpStatus.FORBIDDEN || err?.statusCode === 403;
}

export default defineTool({
  name: 'get_file_link',
  domain: 'files',
  kind: 'read',
  description:
    'Short-lived download link (about 10 minutes) for one file in the signed-in user\'s own File Storage. ' +
    'Pass the key from list_my_files. Refuses a key outside that user\'s file-storage folder. Does not ' +
    'return or summarize the file\'s contents.',
  input: Joi.object({
    key: Joi.string().max(1024).required().description('Object key from list_my_files.'),
  }),
  access: FILES_ACCESS,
  async execute({ key } = {}, ctx) {
    const userId = callerId(ctx);
    const objectKey = typeof key === 'string' ? key.trim() : '';
    if (!isKeyAllowed(objectKey, userId)) return { ...REFUSED };
    const { getDownloadUrl } = filesDeps(ctx);
    try {
      const url = await getDownloadUrl(userId, objectKey);
      if (!url) return { ...REFUSED };
      return { ok: true, url, key: objectKey };
    } catch (err) {
      if (isForbidden(err)) return { ...REFUSED };
      throw err;
    }
  },
});
