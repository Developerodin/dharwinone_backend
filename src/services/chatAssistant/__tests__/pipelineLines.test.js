import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTaskLine } from '../pipelineLines.js';

const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

describe('formatTaskLine', () => {
  it('prints description (trimmed), last update and last comment', () => {
    const line = formatTaskLine({
      title: 'Build login', taskCode: 'ABC-101', status: 'on_going',
      createdAt: '2026-09-01', updatedAt: '2026-09-20', dueDate: '2026-09-18',
      description: 'x'.repeat(400),
      assignedTo: [{ name: 'Rahul' }], createdBy: { name: 'Asha' },
      comments: [
        { content: 'first', commentedBy: { name: 'A' }, createdAt: '2026-09-02' },
        { content: 'blocked on API keys', commentedBy: { name: 'Rahul' }, createdAt: '2026-09-19' },
      ],
    }, { fmtDate });
    assert.match(line, /CODE: ABC-101/);
    assert.match(line, /UPDATED: 2026-09-20/);
    assert.match(line, /DESCRIPTION: x{200}…/);
    assert.match(line, /LAST_COMMENT: "blocked on API keys" — Rahul, 2026-09-19/);
    assert.match(line, /COMMENTS: 2/);
  });

  it('says NOT_RECORDED when there are no comments', () => {
    assert.match(formatTaskLine({ title: 't', comments: [] }, { fmtDate }), /LAST_COMMENT: NOT_RECORDED/);
  });
});
