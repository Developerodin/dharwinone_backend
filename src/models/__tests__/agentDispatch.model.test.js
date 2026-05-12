import { test } from 'node:test';
import assert from 'node:assert/strict';
import AgentDispatch from '../agentDispatch.model.js';

test('AgentDispatch requires meetingId, dispatchId, hmacToken', () => {
  const d = new AgentDispatch({});
  const err = d.validateSync();
  assert.ok(err);
  assert.ok(err.errors.meetingId);
  assert.ok(err.errors.dispatchId);
  assert.ok(err.errors.hmacToken);
});

test('AgentDispatch defaults', () => {
  const d = new AgentDispatch({
    meetingId: 'm', dispatchId: 'd1', hmacToken: 'h',
  });
  assert.equal(d.agentName, 'meeting-summary-agent');
  assert.equal(d.status, 'requested');
});

test('AgentDispatch rejects unknown status', () => {
  const d = new AgentDispatch({
    meetingId: 'm', dispatchId: 'd2', hmacToken: 'h', status: 'banana',
  });
  assert.ok(d.validateSync());
});

test('toJSON strips hmacToken', () => {
  const d = new AgentDispatch({ meetingId: 'm', dispatchId: 'd3', hmacToken: 'super-secret' });
  const json = d.toJSON();
  assert.equal(json.hmacToken, undefined);
});
