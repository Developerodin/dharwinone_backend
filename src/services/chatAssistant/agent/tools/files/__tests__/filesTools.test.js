import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import httpStatus from 'http-status';
import ApiError from '../../../../../../utils/ApiError.js';
import { isKeyAllowed } from '../../../../../fileStorage.service.js';
import { checkAccessRule } from '../../../../toolAccess.js';
import filesDomain from '../index.js';
import listMyFiles from '../listMyFiles.tool.js';
import getFileLink from '../getFileLink.tool.js';
import { FILES_ACCESS } from '../common.js';

const USER = 'user-a';
const OTHER = 'user-b';
const ownKey = `file-storage/${USER}/Projects/brd.pdf`;
const rootKey = `file-storage/${USER}/notes.txt`;
const otherKey = `file-storage/${OTHER}/secret.pdf`;

const userWith = (...perms) => ({ id: USER, authContext: { permissions: new Set(perms) } });

function ctxFor(userId, deps, user = {}) {
  return { user: { id: userId, ...user }, requestId: 'r', deps };
}

describe('files domain', () => {
  it('exports a one-line summary of at most 120 characters and both tools', () => {
    assert.equal(filesDomain.domain, 'files');
    assert.ok(filesDomain.summary.length <= 120 && !/[\r\n]/.test(filesDomain.summary));
    assert.deepEqual(filesDomain.tools.map((tool) => tool.name), ['list_my_files', 'get_file_link']);
    assert.match(filesDomain.instructions, /not captured/);
    assert.match(filesDomain.instructions, /not read file contents|does not read file contents/i);
  });
});

describe('list_my_files', () => {
  it('access denied without files-storage.read; the page alias and a superuser are allowed', async () => {
    assert.deepEqual(FILES_ACCESS, { allOf: ['files-storage.read'] });
    assert.equal((await checkAccessRule(listMyFiles.access, userWith('jobs.read'))).ok, false);
    assert.equal((await checkAccessRule(listMyFiles.access, userWith('files-storage.manage'))).ok, false);
    assert.equal((await checkAccessRule(listMyFiles.access, userWith('files-storage.read'))).ok, true);
    assert.equal((await checkAccessRule(listMyFiles.access, userWith('communication.files-storage:view'))).ok, true);
    assert.equal((await checkAccessRule(listMyFiles.access, { id: USER, platformSuperUser: true })).ok, true);
  });

  it('lists only the caller\'s files, with metadata when S3 has it and null when it does not', async () => {
    const headed = [];
    const seen = {};
    const out = await listMyFiles.execute({ folder: 'Projects', search: 'brd', limit: 10 }, ctxFor(USER, {
      listObjects: async (userId, prefix, options) => {
        seen.userId = userId;
        seen.prefix = prefix;
        seen.options = options;
        return {
          isTruncated: true,
          folders: [
            { name: 'Specs', prefix: `file-storage/${USER}/Projects/Specs/` },
            { name: 'Secret', prefix: `file-storage/${OTHER}/Secret/` },
          ],
          files: [
            { key: ownKey, name: 'brd.pdf', size: 12, lastModified: '2026-09-01T00:00:00.000Z' },
            { key: rootKey, name: 'notes.txt', size: 0, lastModified: '2026-10-01T04:30:00.000Z' },
            { key: otherKey, name: 'secret.pdf', size: 99, lastModified: '2026-10-01T00:00:00.000Z' },
            { key: `file-storage/${USER}/Projects/`, name: '', size: 0, lastModified: null },
            { key: `file-storage/${USER}/Projects/empty.bin`, name: 'empty.bin', size: null, lastModified: null },
          ],
        };
      },
      headObject: async (userId, key) => {
        headed.push({ userId, key });
        if (key === ownKey) return { uploadedby: USER, originalname: 'Project BRD.pdf' };
        return null;
      },
    }));

    assert.equal(seen.userId, USER);
    assert.equal(seen.prefix, 'Projects');
    assert.deepEqual(seen.options, { search: 'brd', maxKeys: 10 });
    assert.deepEqual(headed.map((call) => call.key).sort(), [ownKey, rootKey, `file-storage/${USER}/Projects/empty.bin`].sort());
    assert.equal(out.ok, true);
    assert.equal(out.scope, 'self');
    assert.equal(out.truncated, true);
    assert.equal(out.files.some((file) => file.key === otherKey), false);
    assert.equal(out.folders.some((folder) => folder.name === 'Secret'), false);
    assert.deepEqual(out.folders, [{ name: 'Specs', folder: 'Projects/Specs' }]);
    assert.equal(out.files[0].key, rootKey);
    assert.equal(out.files[0].uploadedBy, null);
    assert.equal(out.files[0].originalName, null);
    assert.equal(out.files[0].folder, null);
    assert.equal(out.files[0].size, 0);
    const brd = out.files.find((file) => file.key === ownKey);
    assert.equal(brd.uploadedBy, USER);
    assert.equal(brd.originalName, 'Project BRD.pdf');
    assert.equal(brd.folder, 'Projects');
    assert.equal(brd.lastModified, '2026-09-01T00:00:00.000Z');
    const missing = out.files.find((file) => file.name === 'empty.bin');
    assert.equal(missing.size, null);
    assert.equal(missing.lastModified, null);
    assert.equal(missing.uploadedBy, null);
    assert.equal(out.files.some((file) => 'body' in file || 'text' in file || 'content' in file), false);
  });

  it('ignores a user id in the arguments and refuses a path that leaves the caller prefix', async () => {
    let called = false;
    const out = await listMyFiles.execute({ folder: '../user-b', userId: OTHER }, ctxFor(USER, {
      listObjects: async () => { called = true; return { files: [], folders: [] }; },
      headObject: async () => { throw new Error('should not head'); },
    }));
    assert.equal(called, false);
    assert.equal(out.refused, true);
    assert.equal(out.total, 0);
    assert.deepEqual(out.files, []);
  });

  it('keeps the file when uploader metadata cannot be read', async () => {
    const out = await listMyFiles.execute({}, ctxFor(USER, {
      listObjects: async () => ({
        files: [{ key: rootKey, name: 'notes.txt', size: 4, lastModified: '2026-10-01T04:30:00.000Z' }],
        folders: [],
      }),
      headObject: async () => {
        throw new Error('S3 head failed');
      },
    }));
    assert.equal(out.files.length, 1);
    assert.equal(out.files[0].uploadedBy, null);
    assert.equal(out.files[0].originalName, null);
    assert.equal(out.files[0].name, 'notes.txt');
  });

  it('fails closed without a user id', async () => {
    const listObjects = async () => {
      throw new Error('no');
    };
    await assert.rejects(
      () => listMyFiles.execute({}, { user: {}, deps: { listObjects } }),
      /authenticated user/
    );
  });

  it('does not let the model pass another person\'s id', () => {
    assert.deepEqual(Object.keys(listMyFiles.jsonSchema.properties).sort(), ['folder', 'limit', 'search']);
  });
});

describe('get_file_link', () => {
  it('access denied without files-storage.read', async () => {
    assert.equal((await checkAccessRule(getFileLink.access, userWith('files-storage.read'))).ok, true);
    assert.equal((await checkAccessRule(getFileLink.access, userWith())).ok, false);
  });

  it('returns the download link for a key in the caller prefix', async () => {
    const seen = {};
    const out = await getFileLink.execute({ key: `  ${ownKey}  ` }, ctxFor(USER, {
      getDownloadUrl: async (userId, key) => {
        seen.userId = userId;
        seen.key = key;
        return 'https://example.invalid/brd';
      },
    }));
    assert.deepEqual(seen, { userId: USER, key: ownKey });
    assert.deepEqual(out, { ok: true, url: 'https://example.invalid/brd', key: ownKey });
    assert.equal(isKeyAllowed(ownKey, USER), true);
  });

  it('refuses a key outside the caller prefix and does not ask S3 for it', async () => {
    const foreign = [
      otherKey,
      `file-storage/${USER}/../${OTHER}/secret.pdf`,
      `file-storage/${USER}/%2e%2e/${OTHER}/secret.pdf`,
      `file-storage/${USER}/secret\\..\\${OTHER}`,
    ];
    for (const key of foreign) {
      let called = false;
      const out = await getFileLink.execute({ key }, ctxFor(USER, {
        getDownloadUrl: async () => { called = true; return 'https://example.invalid/nope'; },
      }));
      assert.equal(isKeyAllowed(key, USER), false, key);
      assert.equal(called, false, key);
      assert.equal(out.ok, false, key);
      assert.equal(out.refused, true, key);
      assert.equal(out.url, null, key);
    }
  });

  it('refuses when the service itself rejects the key', async () => {
    const out = await getFileLink.execute({ key: ownKey }, ctxFor(USER, {
      getDownloadUrl: async () => {
        throw new ApiError(httpStatus.FORBIDDEN, 'Access denied to this object');
      },
    }));
    assert.equal(out.refused, true);
    assert.equal(out.url, null);
  });

  it('does not accept a user id argument', () => {
    assert.deepEqual(Object.keys(getFileLink.jsonSchema.properties), ['key']);
    assert.deepEqual(getFileLink.jsonSchema.required, ['key']);
  });
});
