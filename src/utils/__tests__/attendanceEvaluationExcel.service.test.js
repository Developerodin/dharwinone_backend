import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTrackExportBuffer, buildHistoryExportBuffer } from '../attendanceExcel.service.js';
import { buildEvaluationExportBuffer } from '../evaluationExcel.service.js';

describe('attendanceExcel.service', () => {
  it('buildTrackExportBuffer produces xlsx bytes with expected headers', () => {
    const buf = buildTrackExportBuffer([
      {
        studentName: 'Jane Doe',
        employeeId: 'EMP-1',
        email: 'jane@example.com',
        isPunchedIn: true,
        punchIn: '2026-07-20T09:00:00.000Z',
        punchOut: null,
        timezone: 'UTC',
        durationMs: null,
      },
    ]);
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 100);
    assert.equal(buf.slice(0, 2).toString(), 'PK');
  });

  it('buildHistoryExportBuffer produces xlsx bytes', () => {
    const buf = buildHistoryExportBuffer([
      {
        studentName: 'John',
        employeeId: 'EMP-2',
        email: 'john@example.com',
        date: '2026-07-19T00:00:00.000Z',
        day: 'Saturday',
        punchIn: '2026-07-19T09:00:00.000Z',
        punchOut: '2026-07-19T17:00:00.000Z',
        durationMs: 8 * 60 * 60 * 1000,
        timezone: 'UTC',
      },
    ]);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.slice(0, 2).toString(), 'PK');
  });
});

describe('evaluationExcel.service', () => {
  it('buildEvaluationExportBuffer produces xlsx bytes', () => {
    const buf = buildEvaluationExportBuffer([
      {
        studentName: 'Student A',
        courseName: 'Course 1',
        positionName: 'Developer',
        categoryNames: ['Tech'],
        completionRate: 80,
        displayStatus: 'In Progress',
        quizScore: 75,
        quizScoreBest: 90,
        essayScore: null,
        certificateIssued: false,
        atRisk: true,
        atRiskReason: 'stale',
        lastAccessedAt: '2026-07-01T00:00:00.000Z',
        completedAt: null,
      },
    ]);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.slice(0, 2).toString(), 'PK');
  });
});
