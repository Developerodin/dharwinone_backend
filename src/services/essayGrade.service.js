import OpenAI from 'openai';
import config from '../config/config.js';
import logger from '../config/logger.js';

function getClient() {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

/**
 * Grade a single essay answer against the expected answer using AI with rubric.
 * @param {string} questionText - The question
 * @param {string} expectedAnswer - Reference/model answer
 * @param {string} studentAnswer - Student's typed answer
 * @returns {Promise<{ score: number, feedback: string, rubric?: object, suggestions?: string }>}
 */
export async function gradeEssayAnswer(questionText, expectedAnswer, studentAnswer) {
  const client = getClient();
  if (!client || !expectedAnswer?.trim()) {
    return { score: null, feedback: null, rubric: null, suggestions: null };
  }

  const prompt = `You are an educational evaluator. Grade this student's essay answer using a rubric.

Question: ${questionText}

Expected answer (key points to look for):
${expectedAnswer.slice(0, 2000)}

Student's answer:
${(studentAnswer || '').slice(0, 2000)}

Score the answer on four dimensions (each 0-25 points; total 0-100):
1. accuracy: How correct and relevant is the answer? Does it match key facts from the expected answer? (Use semantic matching: similar meaning in different words still scores well.)
2. completeness: How well does the answer cover the main points from the expected answer?
3. clarity: Is the answer clear, coherent, and well-expressed?
4. criticalThinking: Does the answer show understanding, reasoning, or insight where appropriate?

Return ONLY valid JSON (no markdown):
{
  "score": number 0-100 (sum of the four dimensions),
  "feedback": "brief 1-2 sentence overall feedback",
  "rubric": {
    "accuracy": number 0-25,
    "completeness": number 0-25,
    "clarity": number 0-25,
    "criticalThinking": number 0-25
  },
  "suggestions": "1-3 concrete improvement tips for the student, or empty string if score is high"
}`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    });

    const text = response.choices?.[0]?.message?.content;
    if (!text) return { score: null, feedback: null, rubric: null, suggestions: null };

    const parsed = JSON.parse(text.replace(/```json\s?/gi, '').replace(/```/g, '').trim());
    const score = typeof parsed.score === 'number' ? Math.min(100, Math.max(0, Math.round(parsed.score))) : null;
    const feedback = typeof parsed.feedback === 'string' ? parsed.feedback.trim().slice(0, 500) : null;
    const rubric =
      parsed.rubric && typeof parsed.rubric === 'object'
        ? {
            accuracy: normalizeRubricValue(parsed.rubric.accuracy),
            completeness: normalizeRubricValue(parsed.rubric.completeness),
            clarity: normalizeRubricValue(parsed.rubric.clarity),
            criticalThinking: normalizeRubricValue(parsed.rubric.criticalThinking),
          }
        : null;
    const suggestions =
      typeof parsed.suggestions === 'string' ? parsed.suggestions.trim().slice(0, 600) : null;
    return { score, feedback, rubric, suggestions };
  } catch (err) {
    logger.warn('[Essay grade] AI grading failed', { error: err?.message });
    return { score: null, feedback: null, rubric: null, suggestions: null };
  }
}

function normalizeRubricValue(v) {
  if (typeof v !== 'number') return 0;
  return Math.min(25, Math.max(0, Math.round(v)));
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
        rubric: null,
        suggestions: null,
      });
      continue;
    }

    const { score, feedback, rubric, suggestions } = await gradeEssayAnswer(
      q.questionText,
      q.expectedAnswer,
      a.typedAnswer
    );

    gradedAnswers.push({
      questionIndex: a.questionIndex,
      typedAnswer: a.typedAnswer || '',
      score,
      feedback,
      rubric: rubric || undefined,
      suggestions: suggestions || undefined,
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

/**
 * Generate a brief AI explanation for why the correct quiz answer is right (for wrong answers).
 * @param {string} questionText - The question text
 * @param {Array<{ text: string, isCorrect: boolean }>} options - All options with text and isCorrect
 * @param {number[]} selectedOptionIndices - Indices the student selected
 * @returns {Promise<string|null>} 1-2 sentence explanation or null if AI unavailable
 */
export async function explainQuizCorrectAnswer(questionText, options, selectedOptionIndices) {
  const client = getClient();
  if (!client || !options?.length) return null;

  const correctTexts = options.filter((o) => o.isCorrect).map((o) => o.text);
  const selectedTexts = (selectedOptionIndices || []).map((idx) => options[idx]?.text).filter(Boolean);
  if (correctTexts.length === 0) return null;

  const prompt = `You are an educational helper. A student answered a quiz question incorrectly. In 1-2 short sentences, explain why the correct answer is right. Be clear and encouraging.

Question: ${(questionText || '').slice(0, 500)}

Correct answer(s): ${correctTexts.map((t) => t.slice(0, 200)).join(' | ')}
Student's choice(s): ${selectedTexts.length ? selectedTexts.map((t) => t.slice(0, 200)).join(' | ') : '(none)'}

Return ONLY valid JSON (no markdown):
{"explanation": "your 1-2 sentence explanation"}`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 150,
      response_format: { type: 'json_object' },
    });

    const text = response.choices?.[0]?.message?.content;
    if (!text) return null;

    const parsed = JSON.parse(text.replace(/```json\s?/gi, '').replace(/```/g, '').trim());
    return typeof parsed.explanation === 'string' ? parsed.explanation.trim().slice(0, 500) : null;
  } catch (err) {
    logger.warn('[Quiz explain] AI explanation failed', { error: err?.message });
    return null;
  }
}
