/**
 * Coerce a Q&A question maxMarks; missing or invalid values become 100.
 * @param {unknown} value
 * @returns {number}
 */
export function questionMaxMarks(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return 100
  return n
}

/**
 * Clamp awarded points into 0..maxMarks.
 * @param {unknown} score
 * @param {number} maxMarks
 * @returns {number|null}
 */
export function clampQuestionScore(score, maxMarks) {
  if (score == null || score === '') return null
  const n = Number(score)
  if (!Number.isFinite(n)) return null
  const max = questionMaxMarks(maxMarks)
  return Math.min(max, Math.max(0, Math.round(n)))
}

/**
 * Scale an AI 0–100 score onto the question's maxMarks.
 * @param {number|null} aiScore
 * @param {unknown} maxMarks
 * @returns {number|null}
 */
export function scaleAiScoreToMarks(aiScore, maxMarks) {
  if (typeof aiScore !== 'number' || !Number.isFinite(aiScore)) return null
  const max = questionMaxMarks(maxMarks)
  return Math.round((Math.min(100, Math.max(0, aiScore)) / 100) * max)
}

/**
 * Total max marks across questions (blank optional answers still count so skipping costs points).
 * @param {Array<{ maxMarks?: number }>} questions
 * @returns {number}
 */
export function totalMaxMarks(questions = []) {
  return questions.reduce((sum, q) => sum + questionMaxMarks(q?.maxMarks), 0)
}

/**
 * True when every required question has a numeric score.
 * @param {Array<{ optional?: boolean }>} questions
 * @param {Array<{ questionIndex?: number, score?: number }>} answers
 * @returns {boolean}
 */
export function isEveryRequiredQuestionScored(questions = [], answers = []) {
  return questions.every((q, i) => {
    if (q?.optional === true) return true
    const ans = answers.find((a) => Number(a.questionIndex) === i)
    return typeof ans?.score === 'number' && Number.isFinite(ans.score)
  })
}

/**
 * Sum obtained marks from answers that have numeric scores.
 * @param {Array<{ score?: number }>} answers
 * @returns {number}
 */
export function sumObtainedMarks(answers = []) {
  return answers.reduce((sum, a) => sum + (typeof a.score === 'number' && Number.isFinite(a.score) ? a.score : 0), 0)
}

/**
 * Percentage from obtained/max, or null if max is 0.
 * @param {number} obtained
 * @param {number} max
 * @returns {number|null}
 */
export function percentageFromMarks(obtained, max) {
  if (!max || !Number.isFinite(max) || max <= 0) return null
  return Math.round((obtained / max) * 100)
}

/**
 * Pass/fail when passPercentage is configured; otherwise null.
 * @param {number|null} percentage
 * @param {unknown} passPercentage
 * @returns {boolean|null}
 */
export function passedFromConfig(percentage, passPercentage) {
  if (percentage == null) return null
  if (passPercentage == null || passPercentage === '') return null
  const threshold = Number(passPercentage)
  if (!Number.isFinite(threshold)) return null
  return percentage >= threshold
}
