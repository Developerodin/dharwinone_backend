import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGroupMembersForPrompt,
  buildGroupCapabilitySummary,
  coerceMoreTasksLikely,
  extractCoveredThemes,
  buildGapReason,
} from './pmGroup.js';

const emp = (over) => ({
  fullName: 'Jane Doe',
  email: 'jane@x.com',
  designation: 'Frontend Engineer',
  department: 'Engineering',
  skills: [{ name: 'React' }, { name: 'TypeScript' }],
  ...over,
});

test('buildGroupMembersForPrompt projects name/designation/department/skills', () => {
  const out = buildGroupMembersForPrompt([emp()]);
  assert.deepEqual(out, [
    { name: 'Jane Doe', designation: 'Frontend Engineer', department: 'Engineering', skills: ['React', 'TypeScript'] },
  ]);
});

test('buildGroupMembersForPrompt trims skills to first 8', () => {
  const skills = Array.from({ length: 12 }, (_, i) => ({ name: `s${i}` }));
  const out = buildGroupMembersForPrompt([emp({ skills })]);
  assert.equal(out[0].skills.length, 8);
});

test('buildGroupMembersForPrompt caps roster at 40 members', () => {
  const big = Array.from({ length: 50 }, () => emp());
  assert.equal(buildGroupMembersForPrompt(big).length, 40);
});

test('buildGroupMembersForPrompt falls back to email when no name', () => {
  const out = buildGroupMembersForPrompt([emp({ fullName: '' })]);
  assert.equal(out[0].name, 'jane@x.com');
});

test('buildGroupCapabilitySummary counts members per designation', () => {
  const members = [
    { designation: 'Frontend Engineer' },
    { designation: 'Frontend Engineer' },
    { designation: 'DevOps' },
    { designation: '' },
  ];
  assert.deepEqual(buildGroupCapabilitySummary(members), {
    'Frontend Engineer': 2,
    DevOps: 1,
    Unspecified: 1,
  });
});

test('coerceMoreTasksLikely is true only for boolean true', () => {
  assert.equal(coerceMoreTasksLikely(true), true);
  assert.equal(coerceMoreTasksLikely(false), false);
  assert.equal(coerceMoreTasksLikely('true'), false);
  assert.equal(coerceMoreTasksLikely(undefined), false);
});

test('extractCoveredThemes collects distinct tags and skills', () => {
  const tasks = [
    { tags: ['frontend', 'ui'], requiredSkills: ['React'] },
    { tags: ['frontend'], requiredSkills: ['React', 'CSS'] },
  ];
  assert.deepEqual(extractCoveredThemes(tasks).sort(), ['CSS', 'React', 'frontend', 'ui']);
});

test('extractCoveredThemes caps at 40 entries', () => {
  const tasks = [{ tags: Array.from({ length: 80 }, (_, i) => `t${i}`), requiredSkills: [] }];
  assert.equal(extractCoveredThemes(tasks).length, 40);
});

test('buildGapReason lists missing skills and closest candidates', () => {
  const task = { requiredSkills: ['Kubernetes', 'Terraform'] };
  const members = [
    { _id: 'm1', fullName: 'Ann', skills: [{ name: 'Terraform' }, { name: 'AWS' }] },
    { _id: 'm2', fullName: 'Bob', skills: [{ name: 'React' }] },
  ];
  const r = buildGapReason(task, members);
  assert.deepEqual(r.missingSkills, ['Kubernetes']);
  assert.equal(r.noQualifiedMember, false);
  assert.equal(r.closestCandidates[0].employeeId, 'm1');
  assert.deepEqual(r.closestCandidates[0].matchedSkills, ['Terraform']);
});

test('buildGapReason flags noQualifiedMember when nobody matches', () => {
  const task = { requiredSkills: ['Rust'] };
  const members = [{ _id: 'm1', fullName: 'Ann', skills: [{ name: 'React' }] }];
  const r = buildGapReason(task, members);
  assert.equal(r.noQualifiedMember, true);
  assert.deepEqual(r.missingSkills, ['Rust']);
  assert.deepEqual(r.closestCandidates, []);
});

test('buildGapReason caps closestCandidates at 3', () => {
  const task = { requiredSkills: ['React'] };
  const members = Array.from({ length: 5 }, (_, i) => ({
    _id: `m${i}`,
    fullName: `M${i}`,
    skills: [{ name: 'React' }],
  }));
  assert.equal(buildGapReason(task, members).closestCandidates.length, 3);
});
