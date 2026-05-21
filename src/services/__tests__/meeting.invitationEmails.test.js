import test from 'node:test';
import assert from 'node:assert/strict';
import { getInvitationEmails } from '../meeting.service.js';

test('getInvitationEmails merges hosts + candidate + recruiter + agents, deduped + lowercased', () => {
  const emails = getInvitationEmails({
    hosts: [{ email: 'Host@x.com' }],
    emailInvites: ['Invite@x.com'],
    candidate: { email: 'Cand@x.com' },
    recruiter: { email: 'Rec@x.com' },
    agents: [
      { id: 'a1', email: 'AGENT1@x.com' },
      { id: 'a2', email: 'agent2@x.com' },
      { id: 'a3' },
      { id: 'a4', email: 'agent1@x.com' },
    ],
  });
  assert.deepEqual(
    new Set(emails),
    new Set(['host@x.com', 'invite@x.com', 'cand@x.com', 'rec@x.com', 'agent1@x.com', 'agent2@x.com'])
  );
});

test('getInvitationEmails tolerates a meeting with no agents', () => {
  const emails = getInvitationEmails({ hosts: [{ email: 'h@x.com' }] });
  assert.deepEqual(emails, ['h@x.com']);
});
