import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentTurn, hasRecentAgentTurn, AGENT_TURN_WINDOW_MS } from '../gate.js';

const NOW = new Date('2026-09-28T12:00:00Z');
const ledgerAt = (msAgo) => ({ agentLedger: [{ at: new Date(NOW.getTime() - msAgo), calls: [] }] });

describe('isAgentTurn', () => {
  it('takes a message with a job noun', () => {
    assert.equal(isAgentTurn('how many open jobs do we have', null, NOW), true);
    assert.equal(isAgentTurn('how many AI roles are there', null, NOW), true);
  });

  it('takes a salary ranking question', () => {
    assert.equal(isAgentTurn('top 5 highest paying positions', null, NOW), true);
  });

  it('takes a noun-less follow-up when the agent answered under 30 minutes ago', () => {
    assert.equal(isAgentTurn('and the remote ones?', ledgerAt(5 * 60 * 1000), NOW), true);
  });

  it('skips a noun-less follow-up when the last agent turn is stale', () => {
    assert.equal(isAgentTurn('and the remote ones?', ledgerAt(AGENT_TURN_WINDOW_MS), NOW), false);
    assert.equal(isAgentTurn('and the remote ones?', ledgerAt(2 * 60 * 60 * 1000), NOW), false);
  });

  it('skips a non-job message with no ledger', () => {
    assert.equal(isAgentTurn('who is on leave today', null, NOW), false);
    assert.equal(isAgentTurn('who is on leave today', { agentLedger: [] }, NOW), false);
    assert.equal(isAgentTurn('list user roles and permissions', {}, NOW), false);
  });
});

describe('hasRecentAgentTurn', () => {
  it('reads only the last ledger entry', () => {
    const memDoc = {
      agentLedger: [
        { at: new Date(NOW.getTime() - 60 * 1000), calls: [] },
        { at: new Date(NOW.getTime() - 3 * 60 * 60 * 1000), calls: [] },
      ],
    };
    assert.equal(hasRecentAgentTurn(memDoc, NOW), false);
  });

  it('accepts a serialized timestamp and rejects a missing or bad one', () => {
    assert.equal(hasRecentAgentTurn({ agentLedger: [{ at: new Date(NOW.getTime() - 1000).toISOString() }] }, NOW), true);
    assert.equal(hasRecentAgentTurn({ agentLedger: [{ calls: [] }] }, NOW), false);
    assert.equal(hasRecentAgentTurn({ agentLedger: [{ at: 'not a date' }] }, NOW), false);
  });
});
