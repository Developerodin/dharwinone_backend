import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEssayResultsResponse } from '../studentEssay.service.js';

test('buildEssayResultsResponse maps student answers and grading metadata', () => {
  const playlistItem = {
    title: 'Q&A 1',
    essay: {
      questions: [
        { questionText: 'What is RERA?', expectedAnswer: 'Real Estate Regulation Act' },
        { questionText: 'Define carpet area' },
      ],
    },
  };

  const latestAttempt = {
    attemptNumber: 2,
    submittedAt: new Date('2026-07-16T10:00:00.000Z'),
    timeSpent: 120,
    status: 'graded',
    score: { totalQuestions: 2, correctAnswers: 1, percentage: 75 },
    answers: [
      {
        questionIndex: 0,
        typedAnswer: 'Regulation for real estate',
        score: 80,
        feedback: 'Good summary',
        rubric: { accuracy: 20, completeness: 20, clarity: 20, criticalThinking: 20 },
        suggestions: 'Mention the full expansion',
      },
      { questionIndex: 1, typedAnswer: 'Usable floor area excluding walls' },
    ],
  };

  const result = buildEssayResultsResponse(playlistItem, '11', latestAttempt);

  assert.equal(result.essay.playlistItemId, '11');
  assert.equal(result.essay.title, 'Q&A 1');
  assert.equal(result.essay.questions.length, 2);
  assert.equal(result.essay.questions[0].studentAnswer, 'Regulation for real estate');
  assert.equal(result.essay.questions[0].score, 80);
  assert.equal(result.essay.questions[1].studentAnswer, 'Usable floor area excluding walls');
  assert.equal(result.attempt.attemptNumber, 2);
  assert.equal(result.attempt.score.percentage, 75);
  assert.equal(result.attempt.status, 'graded');
});

test('buildEssayResultsResponse omits empty expected answers', () => {
  const playlistItem = {
    title: 'Reflection',
    essay: { questions: [{ questionText: 'Your thoughts?', expectedAnswer: '   ' }] },
  };
  const latestAttempt = {
    attemptNumber: 1,
    submittedAt: new Date(),
    timeSpent: 0,
    status: 'submitted',
    answers: [{ questionIndex: 0, typedAnswer: 'My answer' }],
  };

  const result = buildEssayResultsResponse(playlistItem, '0', latestAttempt);

  assert.equal(result.essay.questions[0].expectedAnswer, undefined);
  assert.equal(result.attempt.score, undefined);
});
