import OpenAI from 'openai';
import config from '../config/config.js';
import logger from '../config/logger.js';

function getClient() {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

/**
 * Grade a single essay answer against the expected answer using AI.
 * @param {string} questionText - The question
 * @param {string} expectedAnswer - Reference/model answer
 * @param {string} studentAnswer - Student's typed answer
 * @returns {Promise<{ score: number, feedback: string }>} Score 0-100 and brief feedback
 */
export async function gradeEssayAnswer(questionText, expectedAnswer, studentAnswer) {
  const client = getClient();
  if (!client || !expectedAnswer?.trim()) {
    return { score: null, feedback: null };
  }

  const prompt = `You are an educational evaluator. Grade this student's essay answer against the expected/reference answer.

Question: ${questionText}

Expected answer (key points to look for):
${expectedAnswer.slice(0, 2000)}

Student's answer:
${(studentAnswer || '').slice(0, 2000)}

Rate the student's answer from 0 to 100 based on:
- Relevance to the question
- Coverage of key points from the expected answer
- Clarity and coherence
- Use context matching: if the student conveys similar meaning in different words, that should still score well.

Return ONLY valid JSON (no markdown):
{"score": number 0-100, "feedback": "brief 1-2 sentence feedback"}`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    });

    const text = response.choices?.[0]?.message?.content;
    if (!text) return { score: null, feedback: null };

    const parsed = JSON.parse(text.replace(/```json\s?/gi, '').replace(/```/g, '').trim());
    let score = typeof parsed.score === 'number' ? Math.min(100, Math.max(0, Math.round(parsed.score))) : null;
    const feedback = typeof parsed.feedback === 'string' ? parsed.feedback.trim().slice(0, 500) : null;
    return { score, feedback };
  } catch (err) {
    logger.warn('[Essay grade] AI grading failed', { error: err?.message });
    return { score: null, feedback: null };
  }
}

/**
 * Grade all essay answers and compute overall score.
 * @param {Array} questions - [{ questionText, expectedAnswer }]
 * @param {Array} answers - [{ questionIndex, typedAnswer }]
 * @returns {Promise<{ totalQuestions, correctAnswers, percentage, gradedAnswers }>}
 */
export async function gradeEssayAttempt(questions, answers) {
  const gradedAnswers = [];
  let totalScore = 0;
  let gradedCount = 0;

  for (const a of answers) {
    const q = questions[a.questionIndex];
    if (!q) {
      gradedAnswers.push({
        questionIndex: a.questionIndex,
        typedAnswer: a.typedAnswer || '',
        score: null,
        feedback: null,
      });
      continue;
    }

    const { score, feedback } = await gradeEssayAnswer(
      q.questionText,
      q.expectedAnswer,
      a.typedAnswer
    );

    gradedAnswers.push({
      questionIndex: a.questionIndex,
      typedAnswer: a.typedAnswer || '',
      score,
      feedback,
    });

    if (score != null) {
      totalScore += score;
      gradedCount++;
    }
  }

  const totalQuestions = questions.length;
  const avgScore = gradedCount > 0 ? Math.round(totalScore / gradedCount) : 0;
  const percentage = totalQuestions > 0 && gradedCount > 0 ? avgScore : null;

  return {
    totalQuestions,
    correctAnswers: gradedCount > 0 ? Math.round((avgScore / 100) * totalQuestions) : 0,
    percentage: percentage ?? 0,
    gradedAnswers,
  };
}
