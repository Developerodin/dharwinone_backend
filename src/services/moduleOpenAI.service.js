import OpenAI from 'openai';
import config from '../config/config.js';
import logger from '../config/logger.js';

/** Append closing brackets to repair truncated JSON (e.g. from max_tokens cutoff). */
function truncateToBalancedJson(str) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escape = false;
  let quote = null;
  let i = 0;
  const len = str.length;
  while (i < len) {
    const c = str[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === '\\' && i + 1 < len) {
        escape = true;
      } else if (c === quote) {
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      i++;
      continue;
    }
    if (c === '{') braceDepth++;
    else if (c === '}') braceDepth--;
    else if (c === '[') bracketDepth++;
    else if (c === ']') bracketDepth--;
    i++;
  }
  const suffix = ']'.repeat(Math.max(0, bracketDepth)) + '}'.repeat(Math.max(0, braceDepth));
  return str + suffix;
}

/** Parse JSON, repairing common AI output issues (trailing commas, truncated content). */
function parseJsonWithRepair(text, context = '') {
  const raw = (text || '').trim();
  const cleaned = raw
    .replace(/```json\s?/gi, '')
    .replace(/```\s?/g, '')
    .trim();

  const attempts = [
    { name: 'direct', fn: () => JSON.parse(cleaned) },
    {
      name: 'trailing-commas',
      fn: () => {
        const repaired = cleaned.replace(/,(\s*[}\]])/g, '$1');
        return JSON.parse(repaired);
      },
    },
    {
      name: 'truncated-last-brace',
      fn: () => {
        const lastBrace = cleaned.lastIndexOf('}');
        if (lastBrace > 0) {
          const truncated = cleaned.slice(0, lastBrace + 1);
          return JSON.parse(truncated);
        }
        throw new Error('No closing brace');
      },
    },
    {
      name: 'extract-json-object',
      fn: () => {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error('No JSON object found');
      },
    },
    {
      name: 'truncate-and-balance',
      fn: () => {
        const balanced = truncateToBalancedJson(cleaned);
        const repaired = balanced.replace(/,(\s*[}\]])/g, '$1');
        return JSON.parse(repaired);
      },
    },
    {
      name: 'trailing-commas-and-balance',
      fn: () => {
        const repaired = cleaned.replace(/,(\s*[}\]])/g, '$1');
        const balanced = truncateToBalancedJson(repaired);
        return JSON.parse(balanced);
      },
    },
  ];

  let lastError;
  for (const { name, fn } of attempts) {
    try {
      const result = fn();
      if (name !== 'direct') {
        logger.info(`[Module AI] JSON parse repaired with strategy: ${name}`, { context });
      }
      return result;
    } catch (e) {
      lastError = e;
    }
  }

  logger.error('[Module AI] JSON parse failed after all repair attempts', {
    context,
    rawLength: raw.length,
    rawSnippet: raw.slice(0, 500) + (raw.length > 500 ? '...' : ''),
    rawEnd: raw.length > 500 ? '...' + raw.slice(-200) : undefined,
    lastError: lastError?.message,
  });
  throw new Error('OpenAI returned invalid JSON');
}

function getClient() {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAI({ apiKey });
}

export async function generateModuleContent({
  topic,
  pdfText,
  videoContext,
  skillLevel,
  contentTypes,
  extractedContent = {},
  extractedModules = [],
  sectionCount = 0,
}) {
  const client = getClient();
  const level = skillLevel || 'intermediate';
  const types = contentTypes?.length ? contentTypes : ['blog', 'quiz', 'essay'];
  const { quizzes: extractedQuizzes = [], essays: extractedEssays = [] } = extractedContent;
  const hasNestedModules = extractedModules?.length >= 2;

  const videoSection = videoContext?.length
    ? `\nThese YouTube videos (from user links or extracted from the document) are included in the module:\n${videoContext
        .map((v) => `- "${v.title}" (${v.duration} min): ${v.description}`)
        .join('\n')}\nCreate blog content that complements these videos.`
    : '';

  const extractedSection =
    extractedQuizzes.length > 0 || extractedEssays.length > 0
      ? `
PRE-EXTRACTED CONTENT FROM DOCUMENT - USE THIS EXACTLY. Do NOT recreate quiz or essay content.
${extractedQuizzes.length > 0 ? `Quiz questions (use these as-is in a quiz playlist item):\n${JSON.stringify(extractedQuizzes, null, 2)}` : ''}
${extractedEssays.length > 0 ? `Essay questions (use these as-is in an essay playlist item):\n${JSON.stringify(extractedEssays, null, 2)}` : ''}
If extracted content is provided above, include it in your playlist and do NOT generate replacement quiz/essay content.`
      : '';

  const documentSection = pdfText
    ? `\n\nUPLOADED DOCUMENT CONTENT:
${pdfText.slice(0, 12000)}

${extractedSection}

DOCUMENT FORMAT - May include: Module headers, 📺 Video Resources, 📝 Quiz (Q1. A) B) C) D) Answer: X)), 📖 Long-Answer questions.
- Videos are added separately; use document structure for blog flow.
- If quiz/essay was pre-extracted above, USE IT. Otherwise extract from document or create only if missing.`
    : extractedSection || '';

  const createFromScratchSection = !pdfText?.trim()
    ? `

CREATE FROM SCRATCH (no document uploaded): Follow the default template structure.
- Include 1-2 blog items (introductory content, key concepts) based on the topic.
- Include 1 quiz item with 3-5 questions, each with 4 options (A, B, C, D) and correct answer marked.
- Include 1 essay item with 2-3 long-answer practice questions.
- Order: blog(s) → quiz → essay. Videos will be inserted between blog items automatically.
- Make content appropriate for skill level: ${level || 'intermediate'}.`
    : '';

  const multiSectionSection =
    sectionCount > 1 && !pdfText?.trim()
      ? `

MULTIPLE SECTIONS MODE: User provided ${videoContext?.length || sectionCount} videos. Create ${sectionCount} distinct sections/modules.
- Each section = 1 blog + 1 quiz + 1 essay. Return a playlist with ${sectionCount} such groups in order.
- Structure: [blog1, quiz1, essay1, blog2, quiz2, essay2, ...] — ${sectionCount} sections total.
- Each section covers a sub-topic. User will assign their videos to sections manually.`
      : '';

  const nestedModulesSection = hasNestedModules
    ? `

NESTED MODULES MODE: The document has ${extractedModules.length} distinct modules. You MUST return a "sections" array (NOT a flat "playlist").
Each section maps to a module from the document. Use the pre-extracted quiz/essay for each module below.

Per-module extracted content (USE THESE - do NOT recreate):
${extractedModules.map((m) => `\n## ${m.title}\nQuizzes: ${JSON.stringify(m.quizzes || [])}\nEssays: ${JSON.stringify(m.essays || [])}`).join('\n')}

Return JSON with "sections" array:
{
  "moduleName": "string",
  "shortDescription": "string",
  "sections": [
    {
      "title": "Module 1: Introduction to Python",
      "items": [
        { "contentType": "blog", "title": "...", "duration": 5, "blogContent": "<p>...</p>" },
        { "contentType": "quiz", "title": "...", "duration": 5, "quiz": { "questions": [...] } },
        { "contentType": "essay", "title": "...", "duration": 10, "essay": { "questions": [{ "questionText": "...", "expectedAnswer": "..." }] } }
      ]
    },
    { "title": "Module 2: ...", "items": [...] }
  ]
}
Use the EXACT extracted quiz/essay questions from each module. Generate blog content per module. Order items within each section: blog → quiz → essay.`
    : '';

  const prompt = `You are an expert instructional designer. Create a training module on this topic: "${topic}"
Skill level: ${level}
Content types to include: ${types.join(', ')}
${videoSection}${documentSection}${createFromScratchSection}${multiSectionSection}${nestedModulesSection}

Follow this pedagogical progression: Introduce (blog) → Demonstrate (video reference) → Practice (quiz) → Reflect (essay).
Interleave content types; do NOT group all blogs first then all quizzes.
For ${level} level: ${
    level === 'beginner'
      ? 'more blogs/explanations, easier quizzes'
      : level === 'advanced'
        ? 'fewer blogs, harder quizzes, more essays'
        : 'balanced mix'
  }.

Return ONLY valid JSON (no markdown fences).
IMPORTANT: Use ONLY these contentType values: "blog", "quiz", "essay". Never use "video" - videos are added separately.
${hasNestedModules ? 'Return "sections" array as described in NESTED MODULES MODE above. Each section has title and items.' : `Use this exact shape:
{
  "moduleName": "string",
  "shortDescription": "string (2-3 sentences)",
  "playlist": [
    {
      "contentType": "blog",
      "title": "string",
      "duration": number_in_minutes,
      "blogContent": "<p>HTML content</p>"
    },
    {
      "contentType": "quiz",
      "title": "string",
      "duration": 5,
      "difficulty": "easy|medium|hard",
      "quiz": {
        "questions": [
          {
            "questionText": "string",
            "allowMultipleAnswers": false,
            "options": [
              { "text": "string", "isCorrect": true },
              { "text": "string", "isCorrect": false }
            ]
          }
        ]
      }
    },
    {
      "contentType": "essay",
      "title": "string",
      "duration": 10,
      "essay": { "questions": [{ "questionText": "string", "expectedAnswer": "optional reference answer for AI grading" }] }
    }
  ]
}`}
Do NOT include youtube-link items; those are added separately.
${hasNestedModules ? `Generate content for ALL ${extractedModules.length} modules. Use extracted quiz/essay per module when provided.` : 'Generate 6-10 playlist items total (fewer when creating from scratch). Each quiz should have 3-5 questions with 4 options each.'}`;

  logger.info('[Module AI] generateModuleContent calling OpenAI', {
    topic: topic?.slice(0, 60),
    hasPdf: !!pdfText?.trim(),
    hasNestedModules,
    extractedModulesCount: extractedModules?.length ?? 0,
  });

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 16384,
    response_format: { type: 'json_object' },
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text) {
    logger.error('[Module AI] OpenAI returned empty content', { topic: topic?.slice(0, 40) });
    throw new Error('OpenAI returned no content');
  }

  logger.debug('[Module AI] OpenAI response received', { length: text.length });
  return parseJsonWithRepair(text, 'generateModuleContent');
}

/**
 * Generate a single blog post for a module when document has no blog content.
 * Uses document name and module name only (lightweight prompt).
 * @param {{ documentName: string, moduleName: string }} params
 * @returns {Promise<{ title: string, blogContent: string }>}
 */
export async function generateBlogForModule({ documentName, moduleName }) {
  const client = getClient();
  const theme = [documentName, moduleName].filter(Boolean).join(' — ');
  const prompt = `You are writing a short learning blog for a training module.
Course/document context: ${documentName || 'Training'}
Module: ${moduleName || 'Module'}

Write one concise blog post (about 200–400 words) that introduces or summarizes this module for a learner. Use clear paragraphs. No bullet lists unless needed.
Reply in this exact format:
- First line: TITLE: your blog title here
- Then a blank line
- Then the blog body in clear paragraphs (no extra labels).`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 1024,
  });

  const output = response.choices?.[0]?.message?.content;
  if (!output) {
    logger.warn('[Module AI] generateBlogForModule: OpenAI returned empty content');
    return { title: `${moduleName || 'Module'} – Overview`, blogContent: '<p>No content generated.</p>' };
  }

  const titleMatch = output.match(/TITLE:\s*(.+?)(?:\n|$)/i);
  const title = titleMatch ? titleMatch[1].trim() : `${moduleName || 'Module'} – Overview`;
  const bodyStart = output.indexOf('\n\n');
  const body = bodyStart >= 0 ? output.slice(bodyStart).trim() : output.replace(/^TITLE:.*/i, '').trim();
  const blogContent = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
    .join('') || '<p>No content.</p>';

  logger.info('[Module AI] generateBlogForModule done', { moduleName: (moduleName || '').slice(0, 50) });
  return { title, blogContent };
}

/**
 * Generate quiz questions for a module when document has no quiz content.
 * Uses document name and module name only.
 * @param {{ documentName: string, moduleName: string, numQuestions?: number }} params
 * @returns {Promise<{ questions: Array<{ questionText: string, options: Array<{ text: string, isCorrect: boolean }>, allowMultipleAnswers: boolean }> }>}
 */
export async function generateQuizForModule({ documentName, moduleName, numQuestions }) {
  const client = getClient();
  const n = Math.min(Math.max(Number(numQuestions) || 4, 2), 10);
  const prompt = `You are creating a quiz for a training module.
Course/document context: ${documentName || 'Training'}
Module: ${moduleName || 'Module'}

Generate exactly ${n} multiple-choice quiz questions. Each question must have exactly 4 options (A, B, C, D) with one correct answer.

Return ONLY valid JSON (no markdown):
{
  "questions": [
    {
      "questionText": "The question text",
      "options": [
        { "text": "Option A text", "isCorrect": false },
        { "text": "Option B text", "isCorrect": true }
      ],
      "allowMultipleAnswers": false
    }
  ]
}`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.6,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  });

  const output = response.choices?.[0]?.message?.content;
  if (!output) {
    logger.warn('[Module AI] generateQuizForModule: OpenAI returned empty content');
    return { questions: [] };
  }

  try {
    const parsed = parseJsonWithRepair(output, 'generateQuizForModule');
    let questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
    questions = questions.filter((q) => q?.questionText && Array.isArray(q?.options) && q.options.length >= 2);
    if (questions.length === 0) return { questions: [] };
    questions = questions.map((q) => ({
      questionText: String(q.questionText || '').trim(),
      options: (q.options || []).slice(0, 4).map((o) => ({
        text: String(o.text || '').trim(),
        isCorrect: Boolean(o.isCorrect),
      })),
      allowMultipleAnswers: false,
    }));
    logger.info('[Module AI] generateQuizForModule done', { moduleName: (moduleName || '').slice(0, 50), count: questions.length });
    return { questions };
  } catch (err) {
    logger.warn('[Module AI] generateQuizForModule parse failed', { error: err?.message });
    return { questions: [] };
  }
}

/**
 * Generate essay/Q&A questions for a module when document has no essay content.
 * Uses document name and module name only.
 * @param {{ documentName: string, moduleName: string, numQuestions?: number }} params
 * @returns {Promise<{ questions: Array<{ questionText: string, expectedAnswer?: string }> }>}
 */
export async function generateEssayForModule({ documentName, moduleName, numQuestions }) {
  const client = getClient();
  const n = Math.min(Math.max(Number(numQuestions) || 3, 1), 8);
  const prompt = `You are creating long-answer (essay/Q&A) questions for a training module.
Course/document context: ${documentName || 'Training'}
Module: ${moduleName || 'Module'}

Generate exactly ${n} thoughtful long-answer questions that test understanding of the module topic. Each question should require a paragraph or more to answer.

Return ONLY valid JSON (no markdown):
{
  "questions": [
    { "questionText": "First question text?" },
    { "questionText": "Second question text?" }
  ]
}`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.6,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
  });

  const output = response.choices?.[0]?.message?.content;
  if (!output) {
    logger.warn('[Module AI] generateEssayForModule: OpenAI returned empty content');
    return { questions: [] };
  }

  try {
    const parsed = parseJsonWithRepair(output, 'generateEssayForModule');
    let questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
    questions = questions.filter((q) => q?.questionText && String(q.questionText).trim().length >= 10);
    if (questions.length === 0) return { questions: [] };
    questions = questions.map((q) => ({
      questionText: String(q.questionText || '').trim(),
      expectedAnswer: q.expectedAnswer ? String(q.expectedAnswer).trim().slice(0, 1500) : undefined,
    }));
    logger.info('[Module AI] generateEssayForModule done', { moduleName: (moduleName || '').slice(0, 50), count: questions.length });
    return { questions };
  } catch (err) {
    logger.warn('[Module AI] generateEssayForModule parse failed', { error: err?.message });
    return { questions: [] };
  }
}

/**
 * Enhance or generate quiz questions via AI.
 * @param {{ moduleTitle: string, topic?: string, difficulty: 'easy'|'medium'|'hard', existingQuestions?: Array, questionIndices?: 'all'|number[] }}
 */
export async function enhanceQuizWithAI({ moduleTitle, topic, difficulty = 'medium', existingQuestions = [], questionIndices = 'all' }) {
  const client = getClient();
  const diff = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';
  const existingText = existingQuestions.length
    ? existingQuestions.map((q, i) => `${i + 1}. ${q.question || q.questionText || ''}`).join('\n')
    : '';
  const mode = existingQuestions.length === 0 ? 'generate' : 'enhance';
  const indicesHint = mode === 'enhance' && questionIndices !== 'all' && Array.isArray(questionIndices)
    ? `\nOnly enhance questions at indices: ${questionIndices.join(', ')}. Return only those questions.`
    : mode === 'enhance' ? '\nEnhance ALL questions. Return all questions.' : '';
  const prompt = `You are creating/enhancing a quiz for a training module.
Module: ${moduleTitle || 'Module'}
${topic ? `Topic/context: ${topic}` : ''}
Difficulty: ${diff}
${mode === 'generate' ? 'Generate 3–5 multiple-choice quiz questions.' : `Existing questions:\n${existingText}\nEnhance/improve these questions for clarity and better options. Keep the same number of questions.${indicesHint}`}

Each question must have exactly 4 options (A, B, C, D) with one correct answer.
Return ONLY valid JSON (no markdown):
{
  "questions": [
    {
      "questionText": "The question text",
      "options": [
        { "text": "Option A text", "isCorrect": false },
        { "text": "Option B text", "isCorrect": true }
      ],
      "allowMultipleAnswers": false
    }
  ]
}`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.6,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  });

  const output = response.choices?.[0]?.message?.content;
  if (!output) return { questions: [] };
  try {
    const parsed = parseJsonWithRepair(output, 'enhanceQuizWithAI');
    let questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
    questions = questions.filter((q) => q?.questionText && Array.isArray(q?.options) && q.options.length >= 2);
    return {
      questions: questions.map((q) => ({
        questionText: String(q.questionText || '').trim(),
        options: (q.options || []).slice(0, 4).map((o) => ({
          text: String(o.text || '').trim(),
          isCorrect: Boolean(o.isCorrect),
        })),
        allowMultipleAnswers: false,
      })),
    };
  } catch (err) {
    logger.warn('[Module AI] enhanceQuizWithAI parse failed', { error: err?.message });
    return { questions: [] };
  }
}

/**
 * Enhance or generate Q&A (essay) questions via AI.
 * @param {{ moduleTitle: string, topic?: string, difficulty: 'easy'|'medium'|'hard', existingQuestions?: Array, questionIndices?: 'all'|number[] }}
 */
export async function enhanceEssayWithAI({ moduleTitle, topic, difficulty = 'medium', existingQuestions = [], questionIndices = 'all' }) {
  const client = getClient();
  const diff = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';
  const existingText = existingQuestions.length
    ? existingQuestions.map((q, i) => `${i + 1}. ${q.questionText || q.question || ''}`).join('\n')
    : '';
  const mode = existingQuestions.length === 0 ? 'generate' : 'enhance';
  const indicesHint = mode === 'enhance' && questionIndices !== 'all' && Array.isArray(questionIndices)
    ? `\nOnly enhance questions at indices: ${questionIndices.join(', ')}. Return only those questions.`
    : mode === 'enhance' ? '\nEnhance ALL questions. Return all questions.' : '';
  const prompt = `You are creating/enhancing long-answer (Q&A) questions for a training module.
Module: ${moduleTitle || 'Module'}
${topic ? `Topic/context: ${topic}` : ''}
Difficulty: ${diff}
${mode === 'generate' ? 'Generate 2–4 thoughtful long-answer questions.' : `Existing questions:\n${existingText}\nEnhance/improve these questions for clarity.${indicesHint}`}

Return ONLY valid JSON (no markdown):
{
  "questions": [
    { "questionText": "First question text?" },
    { "questionText": "Second question text?" }
  ]
}`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.6,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
  });

  const output = response.choices?.[0]?.message?.content;
  if (!output) return { questions: [] };
  try {
    const parsed = parseJsonWithRepair(output, 'enhanceEssayWithAI');
    let questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
    questions = questions.filter((q) => q?.questionText && String(q.questionText).trim().length >= 10);
    return {
      questions: questions.map((q) => ({
        questionText: String(q.questionText || '').trim(),
        expectedAnswer: q.expectedAnswer ? String(q.expectedAnswer).trim().slice(0, 1500) : undefined,
      })),
    };
  } catch (err) {
    logger.warn('[Module AI] enhanceEssayWithAI parse failed', { error: err?.message });
    return { questions: [] };
  }
}

/**
 * Suggest module name and short description from document.
 * Uses documentTitle as reference when provided (extracted from first page, before "Course Documentation").
 * @param {string} documentText - Full document text
 * @param {string} [documentTitle] - Document/course title (e.g. from first page) — used as reference for GPT
 */
/**
 * Get a multi-module (section) playlist outline from a course title. Used for "create from title" preview.
 * Returns sections in succession: introduction → about the topic → in-depth modules.
 * @param {{ moduleTitle: string, numModules?: number, level?: string, contentTypes?: string[] }}
 * @returns {Promise<{ moduleName: string, shortDescription: string, level: string, sections: Array<{ title: string, items: Array<{ contentType: string, title: string }> }> }>}
 */
export async function getPlaylistOutlineFromTitle(moduleTitle, numModules = 3, level = 'intermediate', contentTypes = ['blog', 'quiz', 'essay']) {
  if (!moduleTitle || typeof moduleTitle !== 'string' || !moduleTitle.trim()) {
    return { moduleName: '', shortDescription: '', level: 'intermediate', sections: [] };
  }
  const client = getClient();
  const topic = moduleTitle.trim();
  const n = Math.min(Math.max(Number(numModules) || 3, 1), 10);
  const lev = ['beginner', 'intermediate', 'advanced'].includes(level) ? level : 'intermediate';
  const types = Array.isArray(contentTypes) && contentTypes.length ? contentTypes : ['blog', 'quiz', 'essay'];
  const hasBlog = types.includes('blog');
  const hasQuiz = types.includes('quiz');
  const hasEssay = types.includes('essay');
  const hasVideo = types.includes('video');

  const prompt = `You are an expert instructional designer. Create a COURSE outline with multiple modules (sections) in succession.

Course title: "${topic}"
Course level: ${lev}
Number of modules (sections): ${n}

Progression: Module 1 = Introduction to the topic. Module 2 = About the topic (overview, key concepts). Module 3+ = Go in depth (each module covers a sub-topic or deeper aspect). Build a logical learning path.

Content types to include in each module: ${types.join(', ')}. Only suggest items for types that are in this list.

Return valid JSON:
- "moduleName": polished course title
- "shortDescription": 2-3 sentences for the whole course
- "level": "${lev}"
- "sections": array of ${n} sections. Each section: { "title": "Module 1: Introduction to ...", "items": [ { "contentType": "blog"|"quiz"|"essay"|"youtube-link", "title": "..." }, ... ] }

Per-section structure: ${hasBlog ? '1-2 blogs (intro/explanation), ' : ''}${hasVideo ? '1-2 youtube-link items (video placeholders with descriptive titles, e.g. "Introduction to X - Video"), ' : ''}${hasQuiz ? '1 quiz, ' : ''}${hasEssay ? '1 essay (Q&A)' : ''}. Order within section: blog(s) first${hasVideo ? ', then video(s) (youtube-link)' : ''}, then quiz, then essay.
IMPORTANT: Use only these contentTypes: blog, quiz, essay${hasVideo ? ', youtube-link' : ''}. ${hasVideo ? 'When "video" is requested, EVERY section MUST include at least one item with "contentType": "youtube-link" and a short "title" (e.g. "Overview video", "Deep dive: Topic X").' : ''}

Return ONLY valid JSON (no markdown):
{
  "moduleName": "string",
  "shortDescription": "string",
  "level": "${lev}",
  "sections": [
    { "title": "Module 1: Introduction to ...", "items": [ { "contentType": "blog", "title": "..." }, ... ] },
    { "title": "Module 2: ...", "items": [ ... ] }
  ]
}
${hasVideo ? 'Include at least one { "contentType": "youtube-link", "title": "..." } in each section\'s items array.' : ''}`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text) {
    logger.warn('[Module AI] getPlaylistOutlineFromTitle: empty response');
    return { moduleName: topic, shortDescription: '', level: lev, sections: [] };
  }
  try {
    const parsed = parseJsonWithRepair(text, 'getPlaylistOutlineFromTitle');
    const sections = Array.isArray(parsed.sections)
      ? parsed.sections.slice(0, n).map((sec) => {
          const title = sec && typeof sec.title === 'string' ? sec.title.trim() : '';
          const items = Array.isArray(sec.items)
            ? sec.items
                .filter((o) => o && (o.contentType === 'blog' || o.contentType === 'quiz' || o.contentType === 'essay' || o.contentType === 'youtube-link'))
                .map((o) => ({ contentType: o.contentType, title: String(o.title || '').trim() || 'Untitled' }))
            : [];
          return { title: title || 'Module', items };
        })
      : [];
    return {
      moduleName: typeof parsed.moduleName === 'string' ? parsed.moduleName.trim() : topic,
      shortDescription: typeof parsed.shortDescription === 'string' ? parsed.shortDescription.trim() : '',
      level: parsed.level || lev,
      sections,
    };
  } catch (err) {
    logger.warn('[Module AI] getPlaylistOutlineFromTitle parse failed', { error: err?.message });
    return { moduleName: topic, shortDescription: '', level: lev, sections: [] };
  }
}

/**
 * Generate full playlist with content from title + user config. Supports multiple sections (modules) in succession.
 * @param {{
 *   moduleName: string,
 *   shortDescription: string,
 *   level?: string,
 *   sections: Array<{ title: string, items: Array<{ contentType: string, title: string }> }>,
 *   numBlogs: number,
 *   numVideos: number,
 *   numQuizzes: number,
 *   questionsPerQuiz: number,
 *   numEssays: number,
 *   questionsPerEssay: number,
 *   videoLanguage?: string,
 *   onProgress?: (message: string) => void
 * }} params
 * @returns {Promise<{ moduleName: string, shortDescription: string, playlist: Array }>}
 */
export async function generateFullPlaylistFromTitleAndConfig({
  moduleName,
  shortDescription,
  level = 'intermediate',
  sections = [],
  numBlogs = 2,
  numVideos = 2,
  numQuizzes = 1,
  questionsPerQuiz = 4,
  numEssays = 1,
  questionsPerEssay = 3,
  videoLanguage = 'en',
  onProgress,
}) {
  const send = (msg) => onProgress && onProgress(msg);
  const docName = moduleName || 'Training';
  const playlist = [];

  if (!sections.length) {
    const outline = [];
    for (let i = 0; i < numBlogs; i++) outline.push({ contentType: 'blog', title: `${moduleName} – Part ${i + 1}` });
    for (let i = 0; i < numVideos; i++) outline.push({ contentType: 'youtube-link', title: `Video ${i + 1}` });
    for (let i = 0; i < numQuizzes; i++) outline.push({ contentType: 'quiz', title: `${moduleName} – Quiz ${i + 1}` });
    for (let i = 0; i < numEssays; i++) outline.push({ contentType: 'essay', title: `${moduleName} – Q&A ${i + 1}` });
    sections = [{ title: moduleName, items: outline }];
  }

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const sec = sections[sIdx];
    const sectionTitle = sec?.title || `Module ${sIdx + 1}`;
    const items = sec?.items || [];
    const titlesByType = { blog: [], quiz: [], essay: [] };
    items.forEach((o) => {
      if (titlesByType[o.contentType]) titlesByType[o.contentType].push(o.title);
    });

    for (let i = 0; i < numBlogs; i++) {
      const title = titlesByType.blog[i] || `${sectionTitle} – Part ${i + 1}`;
      send(`Generating blog: ${title}`);
      const { blogContent } = await generateBlogForModule({ documentName: docName, moduleName: title });
      playlist.push({
        contentType: 'blog',
        title,
        duration: 5,
        blogContent: blogContent || '<p>Content generated.</p>',
        sectionTitle,
        sectionIndex: sIdx,
      });
    }

    if (numVideos > 0) {
      const { searchVideos } = await import('./youtubeSearch.service.js');
      const searchQuery = `${sectionTitle} ${docName} tutorial`.trim();
      send(`Searching YouTube for: ${sectionTitle}`);
      const foundVideos = await searchVideos(searchQuery, numVideos, videoLanguage);
      
      for (let i = 0; i < numVideos; i++) {
        const video = foundVideos[i];
        playlist.push({
          contentType: 'youtube-link',
          title: video?.title || titlesByType['youtube-link']?.[i] || `${sectionTitle} – Video ${i + 1}`,
          duration: video?.duration || 5,
          youtubeUrl: video?.youtubeUrl || '',
          sectionTitle,
          sectionIndex: sIdx,
        });
      }
    }

    for (let i = 0; i < numQuizzes; i++) {
      const title = titlesByType.quiz[i] || `${sectionTitle} – Quiz ${i + 1}`;
      send(`Generating quiz: ${title}`);
      const { questions } = await generateQuizForModule({
        documentName: docName,
        moduleName: title,
        numQuestions: questionsPerQuiz,
      });
      playlist.push({
        contentType: 'quiz',
        title,
        duration: 5,
        difficulty: level === 'beginner' ? 'easy' : level === 'advanced' ? 'hard' : 'medium',
        quiz: { questions: questions || [] },
        quizData: { questions: questions || [] },
        sectionTitle,
        sectionIndex: sIdx,
      });
    }

    for (let i = 0; i < numEssays; i++) {
      const title = titlesByType.essay[i] || `${sectionTitle} – Q&A ${i + 1}`;
      send(`Generating Q&A: ${title}`);
      const { questions } = await generateEssayForModule({
        documentName: docName,
        moduleName: title,
        numQuestions: questionsPerEssay,
      });
      playlist.push({
        contentType: 'essay',
        title,
        duration: 10,
        essay: { questions: questions || [] },
        essayData: { questions: questions || [] },
        sectionTitle,
        sectionIndex: sIdx,
      });
    }
  }

  return { moduleName, shortDescription, playlist };
}

export async function suggestTopicAndDescription(documentText, documentTitle = '') {
  if (!documentText || typeof documentText !== 'string' || documentText.trim().length < 50) {
    return { moduleName: '', shortDescription: '' };
  }
  const client = getClient();
  const titleHint = documentTitle?.trim()
    ? `\nDocument/course title (use as reference): "${documentTitle.trim()}"\n`
    : '';
  const prompt = `Read this training/course document content and suggest:
1. A concise module name (e.g. "Introduction to Project Management")
2. A 2-3 sentence description summarizing what the module teaches
${titleHint}
Document content:
${documentText.slice(0, 8000)}

Return ONLY valid JSON:
{"moduleName": "string", "shortDescription": "string"}`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    max_tokens: 256,
    response_format: { type: 'json_object' },
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text) {
    logger.warn('[Module AI] suggestTopicAndDescription: OpenAI returned empty content');
    return { moduleName: '', shortDescription: '' };
  }
  try {
    const parsed = parseJsonWithRepair(text, 'suggestTopicAndDescription');
    return {
      moduleName: typeof parsed.moduleName === 'string' ? parsed.moduleName.trim() : '',
      shortDescription: typeof parsed.shortDescription === 'string' ? parsed.shortDescription.trim() : '',
    };
  } catch (err) {
    logger.warn('[Module AI] suggestTopicAndDescription parse failed', { error: err?.message });
    return { moduleName: '', shortDescription: '' };
  }
}

export async function refineModuleWithChat({ modulePayload, userMessage }) {
  const client = getClient();
  const prompt = `You are an instructional designer. The user has a training module and wants to modify it.

Current module:
${JSON.stringify(modulePayload, null, 2)}

User request: "${userMessage}"

Apply the user's request and return the FULL updated module as valid JSON (same shape as above). Return ONLY the JSON, no explanation.`;

  logger.info('[Module AI] refineModuleWithChat calling OpenAI', { messageLen: userMessage?.length });

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text) {
    logger.error('[Module AI] refineModuleWithChat: OpenAI returned empty content');
    throw new Error('OpenAI returned no content');
  }
  return parseJsonWithRepair(text, 'refineModuleWithChat');
}
