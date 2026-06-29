import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReassign,
  DEFAULT_OFFBOARDING_STEPS,
  OFFBOARDING_CHECKER_KEYS,
  evaluateSteps,
} from './offboarding.pure.js';

const NOW = new Date('2026-06-26T00:00:00.000Z');

describe('applyReassign', () => {
  it('removes departing user, adds targets, records history', () => {
    const task = { assignedTo: ['userA', 'userB'], formerAssignees: [] };
    const r = applyReassign(task, 'userA', ['userC'], 'offboarding', NOW);
    assert.deepEqual(r.assignedTo, ['userB', 'userC']);
    assert.equal(r.changed, true);
    assert.equal(r.formerAssignees.length, 1);
    assert.equal(r.formerAssignees[0].user, 'userA');
    assert.equal(r.formerAssignees[0].reason, 'offboarding');
    assert.equal(r.formerAssignees[0].removedAt, NOW);
  });

  it('handles populated assignee objects (_id)', () => {
    const task = { assignedTo: [{ _id: 'userA' }, { _id: 'userB' }], formerAssignees: [] };
    const r = applyReassign(task, 'userA', ['userC'], 'offboarding', NOW);
    assert.deepEqual(r.assignedTo, ['userB', 'userC']);
    assert.equal(r.changed, true);
  });

  it('no-op when departing user was not assigned', () => {
    const task = { assignedTo: ['userB'], formerAssignees: [] };
    const r = applyReassign(task, 'userA', ['userC'], 'offboarding', NOW);
    assert.equal(r.changed, false);
    assert.deepEqual(r.formerAssignees, []);
    assert.deepEqual(r.assignedTo, ['userB', 'userC']);
  });

  it('does not duplicate a target already assigned', () => {
    const task = { assignedTo: ['userA', 'userC'], formerAssignees: [] };
    const r = applyReassign(task, 'userA', ['userC'], 'offboarding', NOW);
    assert.deepEqual(r.assignedTo, ['userC']);
  });

  it('preserves prior formerAssignees', () => {
    const prior = { user: 'userZ', removedAt: NOW, reason: 'offboarding' };
    const task = { assignedTo: ['userA'], formerAssignees: [prior] };
    const r = applyReassign(task, 'userA', ['userC'], 'offboarding', NOW);
    assert.equal(r.formerAssignees.length, 2);
    assert.equal(r.formerAssignees[0].user, 'userZ');
  });
});

const FULL_CTX = {
  pendingBackdatedCount: 0,
  hasCompanyEmail: false,
  activeEmailCount: 0,
  openAssignedTaskCount: 0,
  employeeIsActive: false,
  activeTeamRowCount: 0,
  inOrgStructure: false,
};

describe('DEFAULT_OFFBOARDING_STEPS', () => {
  it('has exactly the four code-bound keys in sort order', () => {
    const keys = DEFAULT_OFFBOARDING_STEPS().map((s) => s.checkerKey);
    assert.deepEqual(keys, [
      'attendance_complete',
      'email_deactivated',
      'tasks_reassigned',
      'org_team_disabled',
    ]);
    assert.deepEqual([...OFFBOARDING_CHECKER_KEYS].sort(), [...keys].sort());
  });
});

describe('evaluateSteps', () => {
  it('all green when context is fully offboarded', () => {
    const rows = evaluateSteps(DEFAULT_OFFBOARDING_STEPS(), FULL_CTX);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.done));
  });

  it('attendance not done when a backdated request is pending', () => {
    const rows = evaluateSteps(DEFAULT_OFFBOARDING_STEPS(), { ...FULL_CTX, pendingBackdatedCount: 2 });
    assert.equal(rows.find((r) => r.checkerKey === 'attendance_complete').done, false);
  });

  it('email done when nothing assigned and no active mailbox', () => {
    const rows = evaluateSteps(DEFAULT_OFFBOARDING_STEPS(), FULL_CTX);
    assert.equal(rows.find((r) => r.checkerKey === 'email_deactivated').done, true);
  });

  it('email not done while any mailbox is still active', () => {
    const rows = evaluateSteps(DEFAULT_OFFBOARDING_STEPS(), { ...FULL_CTX, activeEmailCount: 1 });
    assert.equal(rows.find((r) => r.checkerKey === 'email_deactivated').done, false);
  });

  it('email not done while a company mailbox is still assigned (even with no connected account)', () => {
    const rows = evaluateSteps(DEFAULT_OFFBOARDING_STEPS(), { ...FULL_CTX, hasCompanyEmail: true });
    assert.equal(rows.find((r) => r.checkerKey === 'email_deactivated').done, false);
  });

  it('tasks not done with open assigned tasks', () => {
    const rows = evaluateSteps(DEFAULT_OFFBOARDING_STEPS(), { ...FULL_CTX, openAssignedTaskCount: 3 });
    assert.equal(rows.find((r) => r.checkerKey === 'tasks_reassigned').done, false);
  });

  it('org_team not done while team rows OR org membership remain, independent of employee active state', () => {
    // Team rows still active → not done, even if employee already inactive.
    const hasTeam = evaluateSteps(DEFAULT_OFFBOARDING_STEPS(), { ...FULL_CTX, activeTeamRowCount: 1 });
    assert.equal(hasTeam.find((r) => r.checkerKey === 'org_team_disabled').done, false);
    // Still in the org structure (department member or unit head) → not done.
    const inOrg = evaluateSteps(DEFAULT_OFFBOARDING_STEPS(), { ...FULL_CTX, inOrgStructure: true });
    assert.equal(inOrg.find((r) => r.checkerKey === 'org_team_disabled').done, false);
    // Teams archived AND out of org structure while employee still active (notice period) → done.
    const clearedWhileActive = evaluateSteps(DEFAULT_OFFBOARDING_STEPS(), {
      ...FULL_CTX,
      employeeIsActive: true,
      activeTeamRowCount: 0,
      inOrgStructure: false,
    });
    assert.equal(clearedWhileActive.find((r) => r.checkerKey === 'org_team_disabled').done, true);
  });

  it('skips disabled steps and sorts by sortOrder', () => {
    const steps = [
      { checkerKey: 'tasks_reassigned', label: 'b', sortOrder: 1, enabled: true },
      { checkerKey: 'attendance_complete', label: 'a', sortOrder: 0, enabled: true },
      { checkerKey: 'email_deactivated', label: 'c', sortOrder: 2, enabled: false },
    ];
    const rows = evaluateSteps(steps, FULL_CTX);
    assert.deepEqual(rows.map((r) => r.checkerKey), ['attendance_complete', 'tasks_reassigned']);
  });
});
