/**
 * Task board stage vocabulary — maps natural language to schema status values.
 * Schema uses: new, todo, on_going, in_review, completed (see task.model.js).
 */

export const TASK_STAGE_LABELS = Object.freeze({
  new: 'New',
  todo: 'Todo',
  on_going: 'On Going',
  in_review: 'In Review',
  completed: 'Completed',
});

/** @typedef {{ status: string|null, confidence: number, label: string|null, blocked?: boolean }} TaskStageResolution */

const STAGE_PATTERNS = [
  {
    status: 'on_going',
    label: TASK_STAGE_LABELS.on_going,
    re: /\b(on[\s_-]?go(?:a)?ing|ongoing|in[\s_-]?progress|working[\s_-]?on|actively[\s_-]?working)\b/i,
    confidence: 0.92,
  },
  {
    status: 'in_review',
    label: TASK_STAGE_LABELS.in_review,
    re: /\b(in[\s_-]?review|under[\s_-]?review|awaiting[\s_-]?review|\bqa\b|quality[\s_-]?assurance)\b/i,
    confidence: 0.9,
  },
  {
    status: 'new',
    label: TASK_STAGE_LABELS.new,
    re: /\b(new[\s_-]?tasks?|^\s*new\b|\bstage[\s:-]?\s*new\b)/i,
    confidence: 0.85,
  },
  {
    status: 'todo',
    label: TASK_STAGE_LABELS.todo,
    re: /\b(to[\s_-]?do|backlog)\b/i,
    confidence: 0.88,
  },
  {
    status: 'completed',
    label: TASK_STAGE_LABELS.completed,
    re: /\b(completed|done|finished|closed[\s_-]?tasks?)\b/i,
    confidence: 0.88,
  },
  {
    status: null,
    label: 'Blocked',
    blocked: true,
    re: /\bblocked\b/i,
    confidence: 0.95,
  },
];

const COUNT_QUESTION_RE =
  /\b(how many|count|number of|total)\b/i;

const TASK_BOARD_CUE_RE =
  /\b(task[\s_-]?board|kanban|board|column|stage|status)\b/i;

/**
 * @param {string} text
 * @param {{ uiContext?: { currentModule?: string, visibleCounts?: Record<string, number> } }} [queryContext]
 * @returns {TaskStageResolution}
 */
export function resolveTaskStage(text, queryContext = {}) {
  const phrase = String(text || '');
  if (!phrase.trim()) {
    return { status: null, confidence: 0, label: null };
  }

  let best = { status: null, confidence: 0, label: null, blocked: false };

  for (const pat of STAGE_PATTERNS) {
    if (!pat.re.test(phrase)) continue;
    let confidence = pat.confidence;
    if (queryContext.uiContext?.currentModule === 'TaskBoard') confidence += 0.05;
    if (TASK_BOARD_CUE_RE.test(phrase)) confidence += 0.03;
    if (confidence >= best.confidence) {
      best = {
        status: pat.status,
        confidence: Math.min(confidence, 1),
        label: pat.label,
        blocked: !!pat.blocked,
      };
    }
  }

  return best;
}

/**
 * True when the user asks for a count in/on a specific kanban stage.
 * @param {string} text
 * @returns {boolean}
 */
export function isTaskStageCountQuery(text) {
  if (!text || !COUNT_QUESTION_RE.test(text)) return false;
  if (!/\btasks?\b/i.test(text)) return false;
  const stage = resolveTaskStage(text);
  return stage.confidence >= 0.85 && Boolean(stage.status || stage.blocked);
}

/**
 * Map uiContext.visibleCounts key → schema status.
 * @param {string} status
 * @returns {string|null}
 */
export function visibleCountKeyForStatus(status) {
  const map = {
    new: 'new',
    todo: 'todo',
    on_going: 'ongoing',
    in_review: 'review',
    completed: 'completed',
  };
  return map[status] || null;
}

export function stageLabelForStatus(status) {
  return TASK_STAGE_LABELS[status] || String(status || '').replace(/_/g, ' ');
}
