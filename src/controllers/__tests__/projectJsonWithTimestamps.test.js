import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Project from '../../models/project.model.js';
import { projectJsonWithTimestamps } from '../project.controller.js';

test('GET project json keeps createdAt and updatedAt after the toJSON plugin strips them', () => {
  const createdAt = new Date('2023-06-22T00:00:00.000Z');
  const updatedAt = new Date('2024-03-01T15:04:00.000Z');
  const createdBy = new mongoose.Types.ObjectId();
  const project = new Project({
    name: 'Dates survive json',
    createdBy,
    createdAt,
    updatedAt,
  });

  const stripped = project.toJSON();
  assert.equal(stripped.createdAt, undefined);
  assert.equal(stripped.updatedAt, undefined);
  assert.equal(String(stripped.createdBy), String(createdBy));

  const payload = projectJsonWithTimestamps(project);
  const wire = JSON.parse(JSON.stringify(payload));
  assert.equal(wire.createdAt, '2023-06-22T00:00:00.000Z');
  assert.equal(wire.updatedAt, '2024-03-01T15:04:00.000Z');
  assert.equal(String(wire.createdBy), String(createdBy));
  assert.equal(wire.name, 'Dates survive json');
});
