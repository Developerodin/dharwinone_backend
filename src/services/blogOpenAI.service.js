import OpenAI from 'openai';
import config from '../config/config.js';
import logger from '../config/logger.js';

function toSimpleHtml(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
    .join('');
}

function getClient() {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured. Add it to .env');
  }
  return new OpenAI({ apiKey });
}

const DEFAULT_MAX_TOKENS = 4096; // Lower than 8192 for faster responses

async function chat(prompt, options = {}) {
  const client = getClient();
  const response = await client.chat.completions.create({
    model: options.model || 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: options.temperature ?? 0.8,
    max_tokens: options.max_tokens ?? DEFAULT_MAX_TOKENS,
  });
  const text = response.choices?.[0]?.message?.content;
  if (text == null) throw new Error('OpenAI returned no content');
  return text;
}

/**
 * Stream generate/enhance so the client can show content as it arrives (lower perceived latency).
 * Yields { chunk } for each text delta, then { done: true, html } at the end.
 * @param {Object} params - same as generateBlog
 * @returns {AsyncGenerator<{ chunk?: string, done?: boolean, html?: string }>}
 */
export async function* generateBlogStream(params) {
  const { mode, existingContent = '', title = '', keywords = '', wordCount = 500, format = 'neutral' } = params;
  const client = getClient();

  if (mode === 'enhance') {
    const text = (existingContent || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) throw new Error('No content to enhance. Type something or use Generate from title & keywords.');
    logger.info('Blog enhance (stream): calling OpenAI', { inputLength: text.length });
    const prompt = `You are an expert editor. Improve and expand this blog content. Keep the same topic. Keep the tone ${format}. Return only the enhanced blog text, no meta commentary. Use clear paragraphs.\n\n---\n${text}`;
    let full = '';
    const stream = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        yield { chunk: delta };
      }
    }
    const html = toSimpleHtml(full);
    logger.info('Blog enhance (stream): done', { outputLength: full.length });
    yield { done: true, html };
    return;
  }

  if (mode === 'generate') {
    if (!title.trim()) throw new Error('Blog title is required.');
    logger.info('Blog generate (stream): calling OpenAI', { title: title.slice(0, 80) });
    const prompt = `Generate a comprehensive, engaging blog post with the following details:
- Title: ${title}
- Keywords to incorporate: ${keywords || 'general interest'}
- Approximate length: ${wordCount} words
- Tone: ${format}

Make the content original, informative, and suitable for an online audience. Write in a ${format} tone. Use clear paragraphs. Return only the blog body text, no title or meta commentary.`;
    let full = '';
    const stream = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        yield { chunk: delta };
      }
    }
    const html = toSimpleHtml(full);
    logger.info('Blog generate (stream): done', { outputLength: full.length });
    yield { done: true, html };
    return;
  }

  throw new Error('Invalid mode');
}

/**
 * Generate or enhance blog content.
 * @param {Object} params
 * @param {'enhance'|'generate'} params.mode
 * @param {string} [params.existingContent]
 * @param {string} [params.title]
 * @param {string} [params.keywords]
 * @param {number} [params.wordCount]
 * @param {string} [params.format]
 * @returns {Promise<string>} HTML content
 */
export async function generateBlog(params) {
  const { mode, existingContent = '', title = '', keywords = '', wordCount = 500, format = 'neutral' } = params;

  if (mode === 'enhance') {
    const text = (existingContent || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) throw new Error('No content to enhance. Type something or use Generate from title & keywords.');
    logger.info('Blog enhance: calling OpenAI', { inputLength: text.length });
    const prompt = `You are an expert editor. Improve and expand this blog content. Keep the same topic. Keep the tone ${format}. Return only the enhanced blog text, no meta commentary. Use clear paragraphs.\n\n---\n${text}`;
    const output = await chat(prompt, { temperature: 0.8 });
    const html = toSimpleHtml(output);
    logger.info('Blog enhance: done', { outputLength: output.length });
    return html;
  }

  if (mode === 'generate') {
    if (!title.trim()) throw new Error('Blog title is required.');
    logger.info('Blog generate: calling OpenAI', { title: title.slice(0, 80) });
    const prompt = `Generate a comprehensive, engaging blog post with the following details:
- Title: ${title}
- Keywords to incorporate: ${keywords || 'general interest'}
- Approximate length: ${wordCount} words
- Tone: ${format}

Make the content original, informative, and suitable for an online audience. Write in a ${format} tone. Use clear paragraphs. Return only the blog body text, no title or meta commentary.`;
    const output = await chat(prompt, { temperature: 0.8 });
    const html = toSimpleHtml(output);
    logger.info('Blog generate: done', { outputLength: output.length });
    return html;
  }

  throw new Error('Invalid mode');
}

/**
 * Generate one blog from a theme (for multi-blog: AI creates distinct title + content).
 * @param {Object} params
 * @param {string} params.theme
 * @param {number} params.index
 * @param {number} params.total
 * @param {string} [params.keywords]
 * @param {number} [params.wordCount]
 * @param {string} [params.format]
 * @returns {Promise<{ title: string, content: string }>}
 */
export async function generateBlogFromTheme(params) {
  const { theme, index, total, keywords = '', wordCount = 500, format = 'neutral' } = params;

  logger.info('Blog generateFromTheme: calling OpenAI', { theme: theme.slice(0, 50), index: index + 1, total });

  const prompt = `You are writing blog ${index + 1} of ${total} on the same overall theme.
Theme: ${theme}
Keywords to incorporate: ${keywords || 'general interest'}
Approximate length: ${wordCount} words
Tone: ${format}

Create a distinct, specific title for this blog (do not repeat the theme word-for-word), then write the full post in a ${format} tone. Reply in this exact format:
- First line: TITLE: your blog title here
- Then a blank line
- Then the full blog body in clear paragraphs (no extra labels).

Return only those two parts: the TITLE line and the body.`;

  const output = await chat(prompt, { temperature: 0.8 });
  const titleMatch = output.match(/TITLE:\s*(.+?)(?:\n|$)/i);
  const title = titleMatch ? titleMatch[1].trim() : `Blog ${index + 1}`;
  const bodyStart = output.indexOf('\n\n');
  const body = bodyStart >= 0 ? output.slice(bodyStart).trim() : output.replace(/^TITLE:.*/i, '').trim();
  const content = toSimpleHtml(body);
  logger.info('Blog generateFromTheme: done', { index: index + 1, total, title: title.slice(0, 50) });
  return { title, content };
}

/**
 * Get real-time suggestions (typos, spelling, small improvements).
 * @param {Object} params
 * @param {string} params.content
 * @param {string} [params.format]
 * @returns {Promise<{ edits: Array<{ original: string, suggested: string, reason: string }> }>}
 */
export async function getBlogSuggestions(params) {
  const { content, format = 'neutral' } = params;
  const plain = (content || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return { edits: [] };

  if (!config.openai?.apiKey) throw new Error('OPENAI_API_KEY is not configured. Add it to .env');

  logger.info('Blog suggestions: calling OpenAI', { contentLength: plain.length });
  const prompt = `You are an expert editor. Suggest only MINUTE, targeted improvements: fix typos, spelling, and obvious grammar; suggest small word-choice or clarity improvements. Do NOT rewrite whole sentences or change every phrase. Keep the tone ${format}.

Return ONLY a single JSON object, no other text:
{"edits": [{"original": "exact phrase as it appears in the text", "suggested": "replacement", "reason": "spelling"}]}

Rules:
- Each "original" must be an exact substring of the user's text (copy it character-for-character).
- Make 2-8 small edits maximum. Prefer quality over quantity.
- reason: one short word like "spelling", "grammar", "clarity", "word choice".
- Escape quotes in JSON strings (use \\" for quotes inside strings).

Input text:

---
${plain}
---`;

  const output = await chat(prompt, { temperature: 0.3 });
  try {
    const raw = output
      .replace(/```json\s?/gi, '')
      .replace(/```\s?/g, '')
      .trim();
    const parsed = JSON.parse(raw);
    const edits = (Array.isArray(parsed.edits) ? parsed.edits : [])
      .filter((e) => typeof e.original === 'string' && typeof e.suggested === 'string')
      .map((e) => ({
        original: String(e.original),
        suggested: String(e.suggested),
        reason: typeof e.reason === 'string' ? e.reason : 'improvement',
      }));
    logger.info('Blog suggestions: done', { editsCount: edits.length });
    return { edits };
  } catch {
    logger.warn('Blog suggestions: JSON parse failed', { outputSlice: output.slice(0, 200) });
    return { edits: [] };
  }
}
