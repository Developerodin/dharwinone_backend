import { searchVideos, getVideoDetails } from '../services/youtubeSearch.service.js';
import { fetchCoverImage } from '../services/imageSearch.service.js';
import { extractRawTextFromFile, extractDocumentTitle, extractStructuredDataFromExcel } from '../services/documentExtraction.service.js';
import { generateModuleContent, refineModuleWithChat, suggestTopicAndDescription, generateBlogForModule, generateQuizForModule, generateEssayForModule, enhanceQuizWithAI, enhanceEssayWithAI, getPlaylistOutlineFromTitle, generateFullPlaylistFromTitleAndConfig } from '../services/moduleOpenAI.service.js';
import { createTrainingModule, getTrainingModuleById } from '../services/trainingModule.service.js';
import TrainingModule from '../models/trainingModule.model.js';
import logger from '../config/logger.js';

function sendSSE(res, step, status, message, data) {
  res.write(`data: ${JSON.stringify({ step, status, message, data })}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

function initSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

const YOUTUBE_URL_REGEX_SRC = '(?:https?:\\/\\/)?(?:www\\.)?(?:youtube\\.com\\/watch\\?v=|youtu\\.be\\/)([a-zA-Z0-9_-]{11})';

function extractYouTubeUrlsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const re = new RegExp(YOUTUBE_URL_REGEX_SRC, 'g');
  const ids = [];
  let m;
  for (;;) {
    m = re.exec(text);
    if (m === null) break;
    ids.push(m[1]);
  }
  return [...new Set(ids)];
}

/** Extract quiz questions (Q1. ... A) B) C) D) ... Answer: X)) and essay questions (1. 2. 3.) from document text */
function extractContentFromDocument(text) {
  if (!text || typeof text !== 'string') return { quizzes: [], essays: [] };
  const result = { quizzes: [], essays: [] };

  // Quiz: Q1. / Q2. etc with A) B) C) D) and Answer: A) or Answer: A
  const quizSection = text.split(/(?:📖|Long-Answer|Long Answer)/i)[0] || text;
  const qBlocks = quizSection.split(/(?=Q\d+\.)/i).filter((b) => /^Q\d+\./i.test(b.trim()));
  for (const block of qBlocks) {
    const qMatch = block.match(/Q\d+\.\s*(.+?)(?=\s*[A-D]\)|\s*✅|\s*Answer:|$)/s);
    if (!qMatch) continue;
    const questionText = qMatch[1].trim().replace(/\s+/g, ' ');
    const opts = [];
    const answerLineIdx = block.search(/^\s*Answer\s*:/im);
    const optionsArea = answerLineIdx > 0 ? block.slice(0, answerLineIdx) : block;
    const optRe = /([A-D])\)\s*(.+)/g;
    let om;
    for (;;) {
      om = optRe.exec(optionsArea);
      if (om === null) break;
      opts.push({ letter: om[1].toUpperCase(), text: om[2].trim() });
    }
    const ansMatch = block.match(/Answer\s*:\s*([A-D])\)?/i);
    const correctLetter = ansMatch ? ansMatch[1].toUpperCase() : (opts[0]?.letter || null);
    if (questionText && opts.length >= 2) {
      result.quizzes.push({
        questionText,
        options: opts.map((o) => ({ text: o.text, isCorrect: o.letter === correctLetter })),
        allowMultipleAnswers: false,
      });
    }
  }

  // Essay: use shared extractor to avoid answer sub-points (e.g. "1. int (Integer):") being treated as questions
  result.essays = extractEssaysFromSection(text, { includeExpectedAnswer: true });

  return result;
}

/** Shared essay section header regex - matches "Long-Answer Practice Questions", "📖 Long-Answer", etc. */
const ESSAY_SECTION_HEADER = /(?:📖|Long-Answer|Long\s*-\s*Answer|Practice\s+Questions?)[\s\S]*/i;

/** Check if first line of a numbered block is an answer sub-point (e.g. "1. int (Integer):") not a question. */
function looksLikeAnswerSubpoint(firstLine) {
  const t = (firstLine || '').trim();
  return /^\w+\s*\([^)]+\)\s*:?\s*/.test(t) || /^[A-Z][a-z]+(\s*\([^)]+\))?\s*[—\-:]\s*/.test(t);
}

/** Check if first line looks like a question (not an answer sub-point like "1. int (Integer):"). */
function looksLikeQuestion(firstLine) {
  const t = (firstLine || '').trim();
  if (t.length < 10) return false;
  if (t.endsWith('?')) return true;
  if (/^(Explain|What|Why|How|Describe|Compare|Write|List|Define|When|Where|Which)\b/i.test(t)) return true;
  if (looksLikeAnswerSubpoint(t)) return false;
  return true;
}

/** Extract essays from Long-Answer section text. Skips answer sub-points (e.g. "1. int (Integer):") misparsed as questions. */
function extractEssaysFromSection(sectionText, opts = {}) {
  const { includeExpectedAnswer = true } = opts;
  const essays = [];
  const section = (sectionText || '').match(ESSAY_SECTION_HEADER)?.[0] || sectionText || '';
  const re = /(?:^|\n)\s*([1-9]\d*)\.\s+([^\n]+(?:\n(?![1-9]\d*\.\s)[^\n]*)*)/g;
  let m;
  for (;;) {
    m = re.exec(section);
    if (m === null) break;
    const block = m[2].trim();
    const firstLine = block.split(/\n/)[0]?.trim() || '';
    const isModuleHeader = /^Module\s*\d+[:.]?\s/i.test(block) || /Module\s*\d+.*Video Resources/i.test(block);
    const isStructuralOutline = /^(Video Resources|Quiz|Long-Answer|Q&A)\s*$/i.test(block.trim());
    const looksLikeOutline = /Module\s*\d+/.test(block) && /Video Resources|Quiz|Long-Answer\s*Q&A/i.test(block);
    if (block.length < 15 || isModuleHeader || isStructuralOutline || looksLikeOutline) continue;
    if (!looksLikeQuestion(firstLine)) continue;
    let questionText = block;
    let expectedAnswer = '';
    const answerMatch = block.match(/(?:\n|^)\s*(?:Answer|Ans|Solution)[:\s]+([\s\S]*)/i);
    if (answerMatch) {
      questionText = block.slice(0, answerMatch.index).trim();
      expectedAnswer = answerMatch[1].trim().replace(/\s+/g, ' ').slice(0, 1500);
    } else {
      const firstLineEnd = block.indexOf('\n');
      if (firstLineEnd > 0) {
        questionText = block.slice(0, firstLineEnd).trim();
        expectedAnswer = block.slice(firstLineEnd).trim().replace(/\s+/g, ' ').slice(0, 1500);
      }
    }
    questionText = questionText.replace(/\s+/g, ' ').slice(0, 500);
    essays.push(includeExpectedAnswer ? { questionText, expectedAnswer: expectedAnswer || undefined } : { questionText });
  }
  return essays;
}

const DOCUMENT_SECTION_ORDER = ['blog', 'video', 'quiz', 'essay'];

/** Detect section order from extracted module text by finding the first occurrence of each header. */
function detectSectionOrderInModuleText(part) {
  const markers = [
    { key: 'blog', regex: /(?:^|\n)\s*(?:Blog\s+Introduction|Blogs?|Reading|Article)\s*:?\s*(?:\n|$)/im },
    { key: 'video', regex: /(?:^|\n)\s*(?:Videos?|Video\s+Resources?|📺)\s*:?\s*(?:\n|$)/im },
    { key: 'quiz', regex: /(?:^|\n)\s*(?:Quizzes?|📝)\s*:?\s*(?:\n|$)/im },
    { key: 'essay', regex: /(?:^|\n)\s*(?:Long-answer\s+questions?|Long-?Answer|Q\s*&\s*A|📖)\s*:?\s*(?:\n|$)/im },
  ];
  const found = [];
  for (const { key, regex } of markers) {
    const m = part.match(regex);
    if (m && m.index !== undefined) found.push({ key, index: m.index });
  }
  found.sort((a, b) => a.index - b.index);
  const order = found.map((f) => f.key);
  for (const k of DOCUMENT_SECTION_ORDER) {
    if (!order.includes(k)) order.push(k);
  }
  return order;
}


/**
 * Join consecutive lines that are part of the same paragraph.
 * PDF text wraps at visual page width (~80-100 chars per line), creating artificial line breaks
 * in the middle of paragraphs. This re-joins them into logical paragraphs.
 */
function joinWrappedLines(lines) {
  if (!lines || !lines.length) return [];
  const result = [];
  let current = lines[0].trim();
  for (let i = 1; i < lines.length; i++) {
    const prev = current;
    const next = lines[i].trim();
    if (!next) { if (current) result.push(current); current = ''; continue; }
    const prevEndsClean = /[.!?:;'"\u2019\u201D)\]]$/.test(prev);
    const prevIsShort = prev.length < 60;
    const nextStartsUpper = /^[A-Z\u2022\u25B6•▶\d]/.test(next);
    if (prevEndsClean || prevIsShort || (nextStartsUpper && prevEndsClean)) {
      if (current) result.push(current);
      current = next;
    } else {
      current += ' ' + next;
    }
  }
  if (current) result.push(current);
  return result;
}

/** Extract blog content from a module part. Looks for Blog/Blogs/Blog Introduction header then takes content until next section. */
function extractBlogFromModulePart(part) {
  const blogHeaderLabels = [
    /^Blog\s+Introduction\s*:?\s*$/i,
    /^Blogs?\s*:?\s*$/i,
    /^Reading\s*:?\s*$/i,
    /^Article\s*:?\s*$/i,
  ];
  const nextSectionLabels = /^(?:Videos?|Video\s+Resources?|Quizzes?|Long-answer\s+questions?|Long-?Answer|Q\s*&\s*A|Module\s*\d+)\s*:?\s*$/i;

  const lines = part.split(/\n/);
  let blogStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    for (const re of blogHeaderLabels) {
      if (re.test(trimmed)) {
        blogStartLine = i + 1;
        logger.debug(`[BlogExtract] header found at line ${i}: "${trimmed}"`);
        break;
      }
    }
    if (blogStartLine >= 0) break;
  }

  if (blogStartLine < 0) {
    const headerRegexFallback = [
      /(?:^|\n)\s*Blog\s+Introduction\s*:?\s*(?:\n|$)/i,
      /(?:^|\n)\s*Blogs?\s*:?\s*(?:\n|$)/i,
    ];
    for (const re of headerRegexFallback) {
      const m = part.match(re);
      if (m) {
        blogStartLine = part.slice(0, m.index + m[0].length).split(/\n/).length;
        logger.debug(`[BlogExtract] header found by regex fallback: "${m[0].replace(/\n/g, '\\n')}"`);
        break;
      }
    }
  }

  if (blogStartLine < 0) {
    logger.debug(`[BlogExtract] NO header in part (first 200): "${part.slice(0, 200).replace(/\n/g, '\\n')}"`);
    return null;
  }

  const contentLines = [];
  for (let i = blogStartLine; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && nextSectionLabels.test(trimmed)) break;
    if (/^Module\s*\d+[:\s]/i.test(trimmed)) break;
    contentLines.push(lines[i]);
  }

  const cleaned = contentLines.join('\n').trim().slice(0, 15000);
  if (cleaned.replace(/\s+/g, '').length < 10) {
    logger.debug(`[BlogExtract] Blog content too short after header (len=${cleaned.length})`);
    return null;
  }

  const rawLines = cleaned.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const paras = joinWrappedLines(rawLines);
  const firstPara = paras[0]?.trim() || '';
  const isStandaloneTitle = firstPara.length > 5 && firstPara.length < 80;
  const title = isStandaloneTitle ? firstPara.replace(/[….]\s*$/, '').trim() : null;
  const body = title ? paras.slice(1).join('\n').trim() : paras.join('\n').trim();
  const paragraphs = body
    .split(/\n/)
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter((p) => p.length > 0);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blogContent = paragraphs.length > 0
    ? paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')
    : `<p>${esc(body.replace(/\s+/g, ' '))}</p>`;
  const blogParas = paragraphs.filter((p) => p.length > 15 && !/^[A-D]\)/.test(p) && !/^Q\d+\./i.test(p) && !/^https?:\/\/\S+$/i.test(p));
  logger.debug(`[BlogExtract] FOUND blog: title="${title || 'Blog'}", paragraphs=${paragraphs.length}, content length=${blogContent.length}`);
  return { blogTitle: title || 'Blog', blogContent, blogParas: blogParas.slice(0, 10) };
}

/** Strip emoji/icon characters and surrounding whitespace/punctuation from a header line. */
const HEADER_JUNK_RE = /[\u{1F4D6}\u{1F4DD}\u{1F4FA}\u{1F3AC}\u{25B6}\u{2705}\u{1F4D6}-\u{1F4FF}\u{1F300}-\u{1F5FF}\u{2600}-\u{27BF}:\s\t|▶✅📖📝📺🎬]/gu;

/** Normalize section headers in extracted text so extraction works reliably. */
function normalizeDocumentText(text) {
  if (!text || typeof text !== 'string') return text;
  const sectionHeaders = [
    { re: /Blog\s+Introduction/i, label: 'Blog Introduction' },
    { re: /Blogs?/i, label: 'Blogs' },
    { re: /Video\s+Resources?/i, label: 'Videos' },
    { re: /Videos?/i, label: 'Videos' },
    { re: /(?:Module\s+)?Quiz(?:zes?)?/i, label: 'Quizzes' },
    { re: /Long-?[Aa]nswer\s+(?:Practice\s+)?[Qq]uestions?/i, label: 'Long-answer questions' },
  ];
  const lines = text.split(/\n/);
  const normalized = [];
  for (const line of lines) {
    const trimmed = line.trim();
    let replaced = false;
    for (const { re, label } of sectionHeaders) {
      if (re.test(trimmed) && trimmed.replace(re, '').replace(HEADER_JUNK_RE, '').length < 3) {
        normalized.push(label);
        replaced = true;
        break;
      }
    }
    if (!replaced) normalized.push(line);
  }
  return normalized.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Split text by module headers that appear at the start of a line.
 * Requires "Module N:" with a colon to avoid false positives like "csv module 18 min YouTube".
 */
function splitByModuleHeaders(text) {
  const re = /^Module\s+\d+\s*:/im;
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    const match = remaining.match(/\nModule\s+\d+\s*:/i);
    if (!match) {
      parts.push(remaining);
      break;
    }
    const before = remaining.slice(0, match.index);
    if (before.trim()) parts.push(before);
    remaining = remaining.slice(match.index + 1);
  }
  if (!parts.length && text.trim()) {
    const firstMatch = text.match(re);
    if (firstMatch) return [text];
    parts.push(text);
  }
  return parts;
}

/** Reject false module headers (e.g. "Module 18: min" from stray "18: min" or abbreviations). */
function isJunkModuleTitle(titleText) {
  const t = (titleText || '').trim().toLowerCase();
  if (t.length < 4) return true;
  const junk = ['min', 'sec', 'max', 'hr', 'hrs', 'mins', 'secs'];
  if (junk.includes(t) || /^\d+$/.test(t)) return true;
  if (/^\d*\s*min\b/i.test(t)) return true;
  if (/^(youtube|video|quiz|quizzes|blog|long.?answer)/i.test(t)) return true;
  return false;
}

/** Extract content per module (Module 1, Module 2, etc.) from document – for nested module generation. Includes sectionOrder per module. */
function extractContentByModuleFromDocument(text) {
  if (!text || typeof text !== 'string') return [];
  const modules = [];
  let textForModules = text;
  const appendedLinksMatch = text.match(/\n\n\[YouTube links from document\]:\s*\n([\s\S]*)$/i);
  if (appendedLinksMatch) {
    textForModules = text.slice(0, appendedLinksMatch.index).trim();
  }
  const parts = splitByModuleHeaders(textForModules);
  for (const part of parts) {
    const titleMatch = part.match(/^Module\s*(\d+)\s*:\s*([^\n]*)/i);
    if (!titleMatch) continue;
    const num = parseInt(titleMatch[1], 10);
    let titleText = (titleMatch[2] || '').trim();
    if (isJunkModuleTitle(titleText)) continue;
    if (titleText.length < 3) titleText = `Module ${num}`;
    const title = `Module ${titleMatch[1]}: ${titleText}`;
    const sectionOrder = detectSectionOrderInModuleText(part);
    // Include "Module Quiz", "Practice Questions" - split before Long-Answer / Q&A section
    const quizSection = part.split(/(?:📖|Long-Answer|Long\s*-\s*Answer|Practice\s+Questions?)/i)[0] || part;
    const qBlocks = quizSection.split(/(?=Q\d+\.)/i).filter((b) => /^Q\d+\./i.test(b.trim()));
    const quizzes = [];
    for (const block of qBlocks) {
      const qMatch = block.match(/Q\d+\.\s*(.+?)(?=\s*[A-D]\)|\s*\u2705|\s*Answer\s*:|$)/s);
      if (!qMatch) continue;
      const questionText = qMatch[1].trim().replace(/\s+/g, ' ');
      const opts = [];
      const answerLineIdx = block.search(/^\s*Answer\s*:/im);
      const optionsArea = answerLineIdx > 0 ? block.slice(0, answerLineIdx) : block;
      const optRe = /([A-D])\)\s*(.+)/g;
      let om;
      for (;;) {
        om = optRe.exec(optionsArea);
        if (om === null) break;
        opts.push({ letter: om[1].toUpperCase(), text: om[2].trim() });
      }
      const ansMatch = block.match(/Answer\s*:\s*([A-D])\)?/i);
      const correctLetter = ansMatch ? ansMatch[1].toUpperCase() : (opts[0]?.letter || null);
      if (questionText && opts.length >= 2) {
        quizzes.push({
          questionText,
          options: opts.map((o) => ({ text: o.text, isCorrect: o.letter === correctLetter })),
          allowMultipleAnswers: false,
        });
      }
    }
    const essays = extractEssaysFromSection(part, { includeExpectedAnswer: true });
    const blogExtracted = extractBlogFromModulePart(part);
    logger.debug(`[ModuleExtract] Module "${title}": blogExtracted=${blogExtracted ? 'YES (title=' + blogExtracted.blogTitle + ')' : 'NO'}, quizzes=${quizzes.length}, essays=${essays.length}`);
    const videoSectionMatch = part.match(/(?:📺|Video\s+Resources?|Videos?)[:\s]*\n([\s\S]*?)(?=\n\s*(?:Blog|Blogs|Quiz|Quizzes|Long-answer|📖|📝|Module\s*\d+)\s*:?|\n\n\n|$)/i);
    const videoLines = videoSectionMatch
      ? videoSectionMatch[1].split(/\n/).filter((l) => l.trim().length > 3).length
      : 0;
    const contentScore = (blogExtracted ? 10 : 0) + quizzes.length + essays.length;
    const existingIdx = modules.findIndex((m) => m.moduleIndex === num);
    if (existingIdx >= 0) {
      const existingScore =
        (modules[existingIdx].blogContent ? 10 : 0) +
        (modules[existingIdx].quizzes?.length || 0) +
        (modules[existingIdx].essays?.length || 0);
      if (contentScore <= existingScore) continue;
      modules[existingIdx] = {
        moduleIndex: num,
        title,
        quizzes,
        essays,
        sectionOrder,
        blogTitle: blogExtracted?.blogTitle,
        blogContent: blogExtracted?.blogContent,
        videoCount: Math.max(videoLines, 1),
      };
    } else {
      modules.push({
        moduleIndex: num,
        title,
        quizzes,
        essays,
        sectionOrder,
        blogTitle: blogExtracted?.blogTitle,
        blogContent: blogExtracted?.blogContent,
        videoCount: Math.max(videoLines, 1),
      });
    }
  }
  modules.sort((a, b) => (a.moduleIndex - b.moduleIndex));
  return modules.map(({ title, quizzes, essays, sectionOrder, blogTitle, blogContent, videoCount }) => ({
    title,
    quizzes,
    essays,
    sectionOrder,
    blogTitle,
    blogContent,
    videoCount: videoCount || 1,
  }));
}

/**
 * Extract document for display in Create with AI UI. Accepts raw text, normalizes, and returns
 * display-friendly structure: { normalizedText, extractedByModule, youtubeUrls }.
 */
function extractDocumentForDisplay(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { normalizedText: '', extractedByModule: [], youtubeUrls: [], documentTitle: '' };
  }
  const documentTitle = extractDocumentTitle(rawText);
  const normalizedText = normalizeDocumentText(rawText);
  const modules = extractContentByModuleFromDocument(normalizedText);

  const displayModules = [];
  let textForModules = normalizedText;
  const appendedLinksMatch = normalizedText.match(/\n\n\[YouTube links from document\]:\s*\n([\s\S]*)$/i);
  const appendedDocLinks = appendedLinksMatch
    ? extractYouTubeUrlsFromText(appendedLinksMatch[1]).map((id) => `https://www.youtube.com/watch?v=${id}`)
    : [];
  if (appendedLinksMatch) {
    textForModules = normalizedText.slice(0, appendedLinksMatch.index).trim();
  }

  const parts = splitByModuleHeaders(textForModules);
  const moduleVideoSlotCounts = [];

  for (const part of parts) {
    const titleMatch = part.match(/^Module\s*(\d+)\s*:\s*([^\n]*)/i);
    if (!titleMatch) continue;
    const titlePart = (titleMatch[2] || '').trim();
    if (isJunkModuleTitle(titlePart)) continue;
    const title = `Module ${titleMatch[1]}: ${titlePart}`;
    const sectionOrder = detectSectionOrderInModuleText(part);
    const videoIds = extractYouTubeUrlsFromText(part);
    const videos = videoIds.map((id) => `https://www.youtube.com/watch?v=${id}`);
    const blogExtracted = extractBlogFromModulePart(part);
    const blogs = (blogExtracted?.blogParas || []).slice(0, 10);

    // Include "Module Quiz", "Practice Questions" - split before Long-Answer / Q&A section
    const quizSection = part.split(/(?:📖|Long-Answer|Long\s*-\s*Answer|Practice\s+Questions?)/i)[0] || part;
    const qBlocks = quizSection.split(/(?=Q\d+\.)/i).filter((b) => /^Q\d+\./i.test(b.trim()));
    const quizzes = [];
    for (const block of qBlocks) {
      const qMatch = block.match(/Q\d+\.\s*(.+?)(?=\s*[A-D]\)|\s*\u2705|\s*Answer\s*:|$)/s);
      if (!qMatch) continue;
      const questionText = qMatch[1].trim().replace(/\s+/g, ' ');
      const opts = [];
      const answerLineIdx = block.search(/^\s*Answer\s*:/im);
      const optionsArea = answerLineIdx > 0 ? block.slice(0, answerLineIdx) : block;
      const optRe = /([A-D])\)\s*(.+)/g;
      let om;
      for (;;) {
        om = optRe.exec(optionsArea);
        if (om === null) break;
        opts.push({ letter: om[1].toUpperCase(), text: om[2].trim() });
      }
      const ansMatch = block.match(/Answer\s*:\s*([A-D])\)?/i);
      const correctLetter = ansMatch ? ansMatch[1].toUpperCase() : (opts[0]?.letter || null);
      if (questionText && opts.length >= 2) {
        quizzes.push({
          questionText,
          options: opts.map((o) => ({ text: o.text, isCorrect: o.letter === correctLetter })),
        });
      }
    }

    const essays = extractEssaysFromSection(part, { includeExpectedAnswer: false }).map((e) => ({ questionText: e.questionText }));

    if (videos.length || blogs.length || quizzes.length || essays.length) {
      const videoSection = part.match(/(?:📺|Video\s+Resources?|Videos?)[:\s]*\n([\s\S]*?)(?=\n\s*(?:Blog|Blogs|Quiz|Quizzes|Long-answer|📖|📝|Module\s*\d+)\s*:?|\n\n\n|$)/i)?.[1] || '';
      const slotCount = Math.max(
        (videoSection.match(/^\s*[-•*)\d.]+\s+.+$/gm) || []).length,
        videoSection.split(/\n/).filter((l) => l.trim().length > 3).length || (videoSection ? 1 : 0),
        videos.length,
        1
      );
      moduleVideoSlotCounts.push(slotCount);
      displayModules.push({ title, videos, blogs, quizzes, essays, sectionOrder });
    }
  }

  if (appendedDocLinks.length > 0 && displayModules.length > 0) {
    const shownInModules = new Set(displayModules.flatMap((m) => m.videos));
    const unassigned = appendedDocLinks.filter((u) => !shownInModules.has(u));
    const totalSlots = moduleVideoSlotCounts.reduce((a, b) => a + b, 0) || displayModules.length;
    const fracs = moduleVideoSlotCounts.map((s) => (s / totalSlots) * unassigned.length);
    const quotas = fracs.map((f) => Math.floor(f));
    let remainder = unassigned.length - quotas.reduce((a, b) => a + b, 0);
    const byRem = fracs
      .map((f, i) => ({ i, r: f - Math.floor(f) }))
      .sort((a, b) => b.r - a.r);
    for (let k = 0; remainder > 0 && k < byRem.length; k++) {
      quotas[byRem[k].i]++;
      remainder--;
    }
    let linkIdx = 0;
    quotas.forEach((n, modIdx) => {
      for (let j = 0; j < n && linkIdx < unassigned.length; j++) {
        displayModules[modIdx].videos.push(unassigned[linkIdx++]);
      }
    });
  }

  if (displayModules.length === 0) {
    const extractedContent = extractContentFromDocument(normalizedText);
    const docVideos = extractYouTubeUrlsFromText(normalizedText).map((id) => `https://www.youtube.com/watch?v=${id}`);
    if (docVideos.length || extractedContent.quizzes?.length > 0 || extractedContent.essays?.length > 0) {
      displayModules.push({
        title: 'Document',
        videos: docVideos,
        blogs: [],
        quizzes: (extractedContent.quizzes || []).map((q) => ({
          questionText: q.questionText,
          options: q.options || [],
        })),
        essays: (extractedContent.essays || []).map((e) => ({ questionText: e.questionText })),
        sectionOrder: DOCUMENT_SECTION_ORDER,
      });
    }
  }

  const youtubeUrls = [...new Set(displayModules.flatMap((m) => m.videos))];
  return { normalizedText, extractedByModule: displayModules, youtubeUrls, documentTitle };
}

/**
 * Convert extractedByModule (display format from process-document) to format expected by buildPlaylistFromDocument.
 * extractedByModule is the source of truth — if we have data there, we have it; if not, we don't.
 */
function mapExtractedByModuleToPlaylistFormat(extractedByModule) {
  return extractedByModule.map((m) => {
    const blogs = Array.isArray(m.blogs) ? m.blogs : [];
    const blogContent = blogs.length > 0
      ? blogs.map((p) => `<p>${String(p).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join('')
      : null;
    const blogTitle = blogs[0] ? String(blogs[0]).slice(0, 80) + (blogs[0].length > 80 ? '…' : '') : null;
    const quizzes = (m.quizzes || []).map((q) => ({
      questionText: q.questionText,
      options: (q.options || []).map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
      allowMultipleAnswers: false,
    }));
    const essays = (m.essays || []).map((e) => ({ questionText: e.questionText, expectedAnswer: e.expectedAnswer }));
    const videos = Array.isArray(m.videos) ? m.videos : [];
    return {
      title: m.title,
      sectionOrder: Array.isArray(m.sectionOrder) && m.sectionOrder.length ? m.sectionOrder : ['video', 'quiz', 'essay', 'blog'],
      blogTitle: blogTitle || undefined,
      blogContent: blogContent || undefined,
      quizzes,
      essays,
      videoCount: Math.max(videos.length, 1),
    };
  });
}

function inferSectionsFromPlaylist(playlist, expectedCount) {
  const normalize = (item) =>
    item?.contentType === 'video' ? { ...item, contentType: 'youtube-link' } : item;
  const sections = [];
  let current = [];
  for (const item of playlist) {
    const ct = item?.contentType;
    if (ct === 'blog' && current.length > 0) {
      sections.push(current.map(normalize));
      current = [];
    }
    if (ct === 'blog' || ct === 'quiz' || ct === 'essay') current.push(item);
  }
  if (current.length) sections.push(current.map(normalize));
  return sections.map((items, i) => ({
    index: i,
    title: items.find((x) => x.contentType === 'blog')?.title || `Section ${i + 1}`,
    items,
  }));
}

/**
 * Build playlist from extracted document modules.
 * For each module, uses extracted content as-is when present.
 * When a section (blog, quiz, essay, videos) is missing, generates only that section via GPT (or YouTube search for videos)
 * using document name + module name.
 */
async function buildPlaylistFromDocument(extractedModules, extractedContent, videoItems, opts = {}) {
  const { documentName, generateBlog, generateQuiz, generateEssay, searchVideosForModule, sendSSE, res } = opts;
  const mergedPlaylist = [];
  let vIdx = 0;

  const pushWithOrder = (item) => {
    mergedPlaylist.push({ ...item, order: mergedPlaylist.length });
  };

  if (extractedModules.length >= 1) {
    for (let sIdx = 0; sIdx < extractedModules.length; sIdx++) {
      const mod = extractedModules[sIdx];
      const secTitle = mod.title || `Module ${sIdx + 1}`;
      if (sendSSE && res) sendSSE(res, 'creating_course', 'started', `Building ${secTitle} (${sIdx + 1}/${extractedModules.length})...`);
      const sectionOrder = Array.isArray(mod.sectionOrder) && mod.sectionOrder.length
        ? mod.sectionOrder
        : ['video', 'quiz', 'essay', 'blog'];

      for (const contentType of sectionOrder) {
        if (contentType === 'video') {
          const count = mod.videoCount || 1;
          let added = 0;
          while (added < count) {
            if (vIdx < videoItems.length) {
              const v = videoItems[vIdx++];
              pushWithOrder({
                contentType: 'youtube-link',
                title: v.title,
                duration: v.duration ?? 0,
                youtubeUrl: v.youtubeUrl,
                sectionTitle: secTitle,
                sectionIndex: sIdx,
              });
              added++;
            } else if (searchVideosForModule && documentName) {
              if (sendSSE && res) sendSSE(res, 'creating_course', 'started', `Searching videos for ${secTitle}...`);
              const extra = await searchVideosForModule(documentName, secTitle);
              for (let i = 0; i < Math.min(extra.length, count - added); i++) {
                const v = extra[i];
                pushWithOrder({
                  contentType: 'youtube-link',
                  title: v.title,
                  duration: v.duration ?? 0,
                  youtubeUrl: v.youtubeUrl,
                  sectionTitle: secTitle,
                  sectionIndex: sIdx,
                });
                added++;
              }
              break;
            } else {
              break;
            }
          }
        } else if (contentType === 'quiz') {
          if (mod.quizzes?.length > 0) {
            pushWithOrder({
              contentType: 'quiz',
              title: `${secTitle} – Quiz`,
              duration: 5,
              difficulty: 'medium',
              quiz: { questions: mod.quizzes },
              sectionTitle: secTitle,
              sectionIndex: sIdx,
            });
          } else if (generateQuiz) {
            logger.debug(`[BuildPlaylist] Generating quiz for "${secTitle}" — missing in document`);
            if (sendSSE && res) sendSSE(res, 'creating_course', 'started', `Generating quiz for ${secTitle}...`);
            try {
              const { questions } = await generateQuiz(documentName, secTitle);
              if (questions?.length > 0) {
                pushWithOrder({
                  contentType: 'quiz',
                  title: `${secTitle} – Quiz`,
                  duration: 5,
                  difficulty: 'medium',
                  quiz: { questions },
                  sectionTitle: secTitle,
                  sectionIndex: sIdx,
                });
              }
            } catch (err) {
              logger.warn('[Module AI] generateQuizForModule failed', { secTitle, err: err?.message });
            }
          }
        } else if (contentType === 'essay') {
          if (mod.essays?.length > 0) {
            pushWithOrder({
              contentType: 'essay',
              title: `${secTitle} – Q&A`,
              duration: 10,
              essay: { questions: mod.essays },
              sectionTitle: secTitle,
              sectionIndex: sIdx,
            });
          } else if (generateEssay) {
            logger.debug(`[BuildPlaylist] Generating essay/Q&A for "${secTitle}" — missing in document`);
            if (sendSSE && res) sendSSE(res, 'creating_course', 'started', `Generating Q&A for ${secTitle}...`);
            try {
              const { questions } = await generateEssay(documentName, secTitle);
              if (questions?.length > 0) {
                pushWithOrder({
                  contentType: 'essay',
                  title: `${secTitle} – Q&A`,
                  duration: 10,
                  essay: { questions },
                  sectionTitle: secTitle,
                  sectionIndex: sIdx,
                });
              }
            } catch (err) {
              logger.warn('[Module AI] generateEssayForModule failed', { secTitle, err: err?.message });
            }
          }
        } else if (contentType === 'blog') {
          if (mod.blogContent) {
            pushWithOrder({
              contentType: 'blog',
              title: mod.blogTitle || `${secTitle} – Blog`,
              duration: 5,
              blogContent: mod.blogContent,
              sectionTitle: secTitle,
              sectionIndex: sIdx,
            });
          } else if (generateBlog) {
            logger.debug(`[BuildPlaylist] Generating blog for "${secTitle}" — missing in document`);
            if (sendSSE && res) sendSSE(res, 'creating_course', 'started', `Generating blog for ${secTitle}...`);
            try {
              const blog = await generateBlog(documentName, secTitle);
              if (blog?.title && blog?.blogContent) {
                pushWithOrder({
                  contentType: 'blog',
                  title: blog.title,
                  duration: 5,
                  blogContent: blog.blogContent,
                  sectionTitle: secTitle,
                  sectionIndex: sIdx,
                });
              }
            } catch (err) {
              logger.warn('[Module AI] generateBlogForModule failed', { secTitle, err: err?.message });
            }
          }
        }
      }
    }
    while (vIdx < videoItems.length) {
      const v = videoItems[vIdx++];
      pushWithOrder({
        contentType: 'youtube-link',
        title: v.title,
        duration: v.duration ?? 0,
        youtubeUrl: v.youtubeUrl,
      });
    }
  } else {
    const fallbackModuleName = 'Module';
    for (const contentType of DOCUMENT_SECTION_ORDER) {
      if (contentType === 'video') {
        if (videoItems.length > 0) {
          videoItems.forEach((v) => {
            pushWithOrder({
              contentType: 'youtube-link',
              title: v.title,
              duration: v.duration ?? 0,
              youtubeUrl: v.youtubeUrl,
            });
          });
        } else if (searchVideosForModule && documentName) {
          if (sendSSE && res) sendSSE(res, 'creating_course', 'started', 'Searching videos...');
          const extra = await searchVideosForModule(documentName, fallbackModuleName);
          extra.forEach((v) => {
            pushWithOrder({
              contentType: 'youtube-link',
              title: v.title,
              duration: v.duration ?? 0,
              youtubeUrl: v.youtubeUrl,
            });
          });
        }
      } else if (contentType === 'quiz') {
        if (extractedContent.quizzes?.length > 0) {
          pushWithOrder({
            contentType: 'quiz',
            title: 'Module Quiz',
            duration: 5,
            difficulty: 'medium',
            quiz: { questions: extractedContent.quizzes },
          });
        } else if (generateQuiz && documentName) {
          if (sendSSE && res) sendSSE(res, 'creating_course', 'started', 'Generating quiz...');
          try {
            const { questions } = await generateQuiz(documentName, fallbackModuleName);
            if (questions?.length > 0) {
              pushWithOrder({
                contentType: 'quiz',
                title: 'Module Quiz',
                duration: 5,
                difficulty: 'medium',
                quiz: { questions },
              });
            }
          } catch (err) {
            logger.warn('[Module AI] generateQuizForModule failed (no modules)', { err: err?.message });
          }
        }
      } else if (contentType === 'essay') {
        if (extractedContent.essays?.length > 0) {
          pushWithOrder({
            contentType: 'essay',
            title: 'Q&A',
            duration: 10,
            essay: { questions: extractedContent.essays },
          });
        } else if (generateEssay && documentName) {
          if (sendSSE && res) sendSSE(res, 'creating_course', 'started', 'Generating Q&A...');
          try {
            const { questions } = await generateEssay(documentName, fallbackModuleName);
            if (questions?.length > 0) {
              pushWithOrder({
                contentType: 'essay',
                title: 'Q&A',
                duration: 10,
                essay: { questions },
              });
            }
          } catch (err) {
            logger.warn('[Module AI] generateEssayForModule failed (no modules)', { err: err?.message });
          }
        }
      } else if (contentType === 'blog') {
        if (generateBlog && documentName) {
          if (sendSSE && res) sendSSE(res, 'creating_course', 'started', 'Generating blog...');
          try {
            const blog = await generateBlog(documentName, fallbackModuleName);
            if (blog?.title && blog?.blogContent) {
              pushWithOrder({
                contentType: 'blog',
                title: blog.title,
                duration: 5,
                blogContent: blog.blogContent,
              });
            }
          } catch (err) {
            logger.warn('[Module AI] generateBlogForModule failed (no modules)', { err: err?.message });
          }
        }
      }
    }
  }
  return mergedPlaylist;
}

function calculateEstimatedDuration(playlist) {
  let total = 0;
  for (const item of playlist) {
    switch (item.contentType) {
      case 'blog': {
        const words = (item.blogContent || '').replace(/<[^>]+>/g, ' ').split(/\s+/).length;
        total += Math.ceil(words / 200);
        break;
      }
      case 'youtube-link':
      case 'upload-video':
        total += item.duration || 0;
        break;
      case 'quiz':
        total += 5;
        break;
      case 'essay':
        total += 10;
        break;
      case 'test':
        total += 5;
        break;
      default:
        total += item.duration || 0;
    }
  }
  return total;
}

export const generateWithAI = async (req, res) => {
  initSSE(res);

  try {
    const { topic, description, pdfText, videoLinks, skillLevel, contentTypes, extractedByModule, videoLanguage: videoLanguageParam } = req.body;
    const videoLanguage = (videoLanguageParam && String(videoLanguageParam).trim().toLowerCase().slice(0, 2)) || 'en';
    const idsFromLinksUser = (videoLinks || [])
      .map((url) => {
        const m = String(url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
    const userProvidedVideos = idsFromLinksUser.length > 0;
    if (!topic?.trim()) {
      sendSSE(res, 'error', 'error', 'Topic is required');
      res.end();
      return;
    }

    sendSSE(res, 'analyzing', 'started', 'Analyzing topic...');
    sendSSE(res, 'analyzing', 'completed', 'Topic analyzed');

    if (pdfText?.trim()) {
      sendSSE(res, 'reading_document', 'started', 'Reading document...');
      sendSSE(res, 'reading_document', 'completed', 'Done reading document');

      sendSSE(res, 'extracting_links', 'started', 'Extracting links and data from document...');
    }

    const idsFromLinks = (videoLinks || [])
      .map((url) => {
        const m = String(url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
    const idsFromDocument = extractYouTubeUrlsFromText(pdfText);
    const allVideoIds = [...new Set([...idsFromLinks, ...idsFromDocument])];

    const normalizedPdfText = pdfText?.trim() ? normalizeDocumentText(pdfText) : '';
    if (normalizedPdfText) {
      logger.debug(`[Module AI] Normalized text (first 500): "${normalizedPdfText.slice(0, 500).replace(/\n/g, '\\n')}"`);
    }
    const extractedContent = normalizedPdfText ? extractContentFromDocument(normalizedPdfText) : { quizzes: [], essays: [] };
    let extractedModules;
    if (Array.isArray(extractedByModule) && extractedByModule.length > 0) {
      extractedModules = mapExtractedByModuleToPlaylistFormat(extractedByModule);
      logger.info('[Module AI] Using extractedByModule from frontend as source of truth', { count: extractedModules.length });
    } else {
      extractedModules = normalizedPdfText ? extractContentByModuleFromDocument(normalizedPdfText) : [];
    }
    if (pdfText?.trim()) {
      const modCount = extractedModules.length;
      sendSSE(
        res,
        'extracting_links',
        'completed',
        idsFromDocument.length
          ? `Done extracting — found ${idsFromDocument.length} YouTube link(s)${extractedContent.quizzes.length || extractedContent.essays.length ? `, ${extractedContent.quizzes.length} quiz Q(s), ${extractedContent.essays.length} essay Q(s)` : ''}${modCount >= 2 ? `, ${modCount} nested modules` : ''}`
          : modCount >= 2
            ? `Done extracting — ${modCount} nested modules detected`
            : 'Done extracting — no YouTube links in document'
      );
    }

    let videos = [];
    if (allVideoIds.length) {
      sendSSE(res, 'fetching_videos', 'started', 'Fetching video details...');
      videos = await getVideoDetails(allVideoIds);
      sendSSE(res, 'fetching_videos', 'completed', `Done — got details for ${videos.length} videos`);
      // When API fails or YOUTUBE_API_KEY not set, create placeholders from extracted IDs so videos still appear in playlist
      if (videos.length === 0 && allVideoIds.length) {
        videos = allVideoIds.map((id, i) => ({
          youtubeUrl: `https://www.youtube.com/watch?v=${id}`,
          title: `Video ${i + 1}`,
          description: '',
          duration: 0,
        }));
        logger.info('[Module AI] Using placeholder video items (YouTube API unavailable or returned empty)', { count: videos.length });
      }
    } else {
      sendSSE(res, 'searching_youtube', 'started', 'Searching YouTube for videos...');
      videos = await searchVideos(topic, 3, videoLanguage);
      sendSSE(res, 'searching_youtube', 'completed', `Done — found ${videos.length} relevant videos`);
    }

    // YouTube links from create-with-AI go into playlist as youtube-link (same as quiz → quiz, essay → essay).
    const videoItems = videos.map((v, i) => ({
      contentType: 'youtube-link',
      title: v.title,
      duration: v.duration,
      youtubeUrl: v.youtubeUrl,
      order: i,
    }));

    const documentHasContent =
      pdfText?.trim() &&
      (extractedModules.length >= 1 || extractedContent.quizzes?.length > 0 || extractedContent.essays?.length > 0);

    let mergedPlaylist;
    let moduleNameFromAI = topic;
    let shortDescriptionFromAI = description || topic;

    if (documentHasContent) {
      sendSSE(res, 'creating_course', 'started', 'Building from document — generating title & description only...');
      const documentTitle = extractDocumentTitle(pdfText) || topic?.trim();
      const suggested = await suggestTopicAndDescription(pdfText, documentTitle);
      if (suggested.moduleName) moduleNameFromAI = suggested.moduleName;
      if (suggested.shortDescription) shortDescriptionFromAI = suggested.shortDescription;
      mergedPlaylist = await buildPlaylistFromDocument(extractedModules, extractedContent, videoItems, {
        documentName: documentTitle || topic,
        generateBlog: async (docName, moduleName) => {
          const { title, blogContent } = await generateBlogForModule({ documentName: docName, moduleName });
          return { title, blogContent };
        },
        generateQuiz: async (docName, moduleName) => {
          return await generateQuizForModule({ documentName: docName, moduleName });
        },
        generateEssay: async (docName, moduleName) => {
          return await generateEssayForModule({ documentName: docName, moduleName });
        },
        searchVideosForModule: async (docName, moduleName) => {
          return await searchVideos([docName, moduleName].filter(Boolean).join(' '), 3, videoLanguage);
        },
        sendSSE,
        res,
      });
      sendSSE(res, 'creating_course', 'completed', 'Done — playlist built from document');
      logger.info('[Module AI] Used document-only path (no content generation)', {
        modules: extractedModules.length,
        playlistItems: mergedPlaylist.length,
      });
    } else {
      const MAX_MODULES_FOR_AI = 10;
      const creatingMsg =
        extractedModules.length > MAX_MODULES_FOR_AI
          ? `Creating course (first ${MAX_MODULES_FOR_AI} of ${extractedModules.length} modules)...`
          : 'Creating course content...';
      sendSSE(res, 'creating_course', 'started', creatingMsg);
      const sectionCount =
        userProvidedVideos && !pdfText?.trim() && videos.length > 1 ? videos.length : 0;
      const modulesForAI =
        extractedModules.length > MAX_MODULES_FOR_AI
          ? extractedModules.slice(0, MAX_MODULES_FOR_AI)
          : extractedModules;
      if (extractedModules.length > MAX_MODULES_FOR_AI) {
        logger.warn('[Module AI] Document has many modules — using first %s to avoid response truncation', MAX_MODULES_FOR_AI, {
          total: extractedModules.length,
          using: modulesForAI.length,
        });
      }
      const generated = await generateModuleContent({
        topic,
        pdfText,
        videoContext: videos,
        skillLevel,
        contentTypes,
        extractedContent,
        extractedModules: modulesForAI,
        sectionCount,
      });
      sendSSE(res, 'creating_course', 'completed', 'Done creating course content');
      moduleNameFromAI = generated.moduleName || topic;
      shortDescriptionFromAI = generated.shortDescription || description || topic;

      const aiSections = generated.sections;
      const aiPlaylist = generated.playlist || (aiSections ? [] : []);
      const normalizeContentType = (item) => {
        if (item.contentType === 'video') return { ...item, contentType: 'youtube-link' };
        return item;
      };

      let flatPlaylist = aiPlaylist;
      if (aiSections?.length > 0) {
        flatPlaylist = [];
        for (let sIdx = 0; sIdx < aiSections.length; sIdx++) {
          const sec = aiSections[sIdx];
          const secTitle = typeof sec === 'object' && sec !== null ? sec.title : `Section ${sIdx + 1}`;
          const items = Array.isArray(sec?.items) ? sec.items : [];
          const modContent = modulesForAI[sIdx];
          for (const it of items) {
            let item = normalizeContentType(it);
            item.sectionTitle = secTitle;
            item.sectionIndex = sIdx;
            if (item.contentType === 'quiz' && modContent?.quizzes?.length > 0) {
              item = { ...item, quiz: { questions: modContent.quizzes }, quizData: { questions: modContent.quizzes } };
            }
            if (item.contentType === 'essay' && modContent?.essays?.length > 0) {
              item = { ...item, essay: { questions: modContent.essays }, essayData: { questions: modContent.essays } };
            }
            flatPlaylist.push(item);
          }
        }
      }

      if (userProvidedVideos && !pdfText?.trim() && videos.length > 1) {
        sendSSE(res, 'assign_videos', 'started', 'Assign videos to sections', {
          requiresAssignment: true,
          moduleName: moduleNameFromAI,
          shortDescription: shortDescriptionFromAI,
          sections: aiSections?.length
            ? aiSections.map((s, i) => ({ index: i, title: s?.title || `Section ${i + 1}`, items: s?.items || [] }))
            : inferSectionsFromPlaylist(flatPlaylist, videos.length),
          videos: videos.map((v) => ({ title: v.title, duration: v.duration, youtubeUrl: v.youtubeUrl })),
        });
        sendSSE(res, 'done', 'completed', 'Assign your videos to sections, then complete.', {
          requiresAssignment: true,
        });
        res.end();
        return;
      }

      mergedPlaylist = [];
      let vIdx = 0;
      for (let i = 0; i < flatPlaylist.length; i++) {
        let item = normalizeContentType(flatPlaylist[i]);
        if (item.contentType === 'quiz' && !item.quiz?.questions?.length) {
          const qs = item.sectionIndex != null && modulesForAI[item.sectionIndex]?.quizzes?.length
            ? modulesForAI[item.sectionIndex].quizzes
            : extractedContent.quizzes;
          if (qs?.length) item = { ...item, quiz: { questions: qs }, quizData: { questions: qs } };
        }
        if (item.contentType === 'essay' && !item.essay?.questions?.length) {
          const es = item.sectionIndex != null && modulesForAI[item.sectionIndex]?.essays?.length
            ? modulesForAI[item.sectionIndex].essays
            : extractedContent.essays;
          if (es?.length) item = { ...item, essay: { questions: es }, essayData: { questions: es } };
        }
        mergedPlaylist.push(item);
        if (item.contentType === 'blog' && vIdx < videoItems.length) {
          const videoItem = videoItems[vIdx++];
          mergedPlaylist.push({
            ...videoItem,
            sectionTitle: item.sectionTitle,
            sectionIndex: item.sectionIndex,
          });
        }
      }
      while (vIdx < videoItems.length) {
        mergedPlaylist.push(videoItems[vIdx++]);
      }

      if (extractedContent.quizzes?.length > 0 && !mergedPlaylist.some((p) => p.contentType === 'quiz')) {
        mergedPlaylist.push({
          contentType: 'quiz',
          title: 'Module Quiz',
          duration: 5,
          quiz: { questions: extractedContent.quizzes },
          order: mergedPlaylist.length,
        });
      }
      if (extractedContent.essays?.length > 0 && !mergedPlaylist.some((p) => p.contentType === 'essay')) {
        mergedPlaylist.push({
          contentType: 'essay',
          title: 'Long-Answer Practice',
          duration: 10,
          essay: { questions: extractedContent.essays },
          order: mergedPlaylist.length,
        });
      }
    }

    sendSSE(res, 'cover_image', 'started', 'Finding cover image...');
    let coverImageFile = null;
    try {
      coverImageFile = await fetchCoverImage(moduleNameFromAI || topic);
    } catch (err) {
      logger.warn('Cover image fetch failed', err);
    }
    sendSSE(res, 'cover_image', 'completed', coverImageFile ? 'Done — cover image found' : 'Done — no cover image (can add later)');

    sendSSE(res, 'saving', 'started', 'Saving module...');
    const estimatedDuration = calculateEstimatedDuration(mergedPlaylist);
    const moduleBody = {
      moduleName: moduleNameFromAI || topic || 'AI Module',
      shortDescription: shortDescriptionFromAI || description || topic,
      playlist: mergedPlaylist,
      status: 'draft',
      estimatedDuration,
      coverImageFile,
    };
    const savedModule = await createTrainingModule(moduleBody, req.user);
    sendSSE(res, 'saving', 'completed', 'Done — module saved');

    sendSSE(res, 'done', 'completed', 'All done! Module created successfully.', { moduleId: savedModule.id });
  } catch (err) {
    logger.error('AI generate failed', err);
    sendSSE(res, 'error', 'error', err.message || 'Generation failed');
  }
  res.end();
};

export const extractDocument = async (req, res) => {
  try {
    const { rawText } = req.body || {};
    const result = extractDocumentForDisplay(rawText || '');
    res.json(result);
  } catch (err) {
    logger.error('Extract document failed', err);
    res.status(500).json({ message: err.message || 'Failed to extract document' });
  }
};

/** Process uploaded file: extract text, normalize, extract modules, fetch video metadata. Frontend only displays. */
export const processDocument = async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) {
      return res.status(400).json({ message: 'File is required' });
    }
    const filename = file.originalname || file.name || 'document';
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const isExcel = ['xlsx', 'xls'].includes(ext) ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel';

    let normalizedText;
    let extractedByModule;
    let youtubeUrls;
    let documentTitle;

    if (isExcel) {
      const result = extractStructuredDataFromExcel(file.buffer);
      normalizedText = result.normalizedText;
      extractedByModule = result.extractedByModule;
      youtubeUrls = result.youtubeUrls;
      documentTitle = result.documentTitle;
      logger.info('[ProcessDocument] Excel structured extraction', {
        modules: extractedByModule.length,
        videos: youtubeUrls.length,
        title: documentTitle,
      });
    } else {
      const rawText = await extractRawTextFromFile(file.buffer, file.mimetype, filename);
      const displayResult = extractDocumentForDisplay(rawText);
      normalizedText = displayResult.normalizedText;
      extractedByModule = displayResult.extractedByModule;
      youtubeUrls = displayResult.youtubeUrls;
      documentTitle = displayResult.documentTitle;
    }

    const ids = youtubeUrls
      .map((url) => {
        const m = String(url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
    let videos = [];
    if (ids.length) {
      try {
        videos = await getVideoDetails(ids);
      } catch (vErr) {
        logger.warn('Video details fetch failed', vErr);
        videos = ids.map((id, i) => ({
          youtubeUrl: `https://www.youtube.com/watch?v=${id}`,
          title: `Video ${i + 1}`,
          duration: 0,
        }));
      }
    }
    res.json({ normalizedText, extractedByModule, youtubeUrls, videos, documentTitle });
  } catch (err) {
    logger.error('Process document failed', err);
    res.status(500).json({ message: err.message || 'Failed to process document' });
  }
};

export const suggestTopicDescription = async (req, res) => {
  try {
    const { documentText } = req.body || {};
    const result = await suggestTopicAndDescription(documentText || '');
    res.json(result);
  } catch (err) {
    logger.error('Suggest topic/description failed', err);
    res.status(500).json({ message: err.message || 'Failed to suggest topic and description' });
  }
};

/** Get playlist outline (preview) from course title. POST body: { moduleTitle, numModules, level, contentTypes } */
export const getPlaylistOutline = async (req, res) => {
  try {
    const { moduleTitle, numModules, level, contentTypes } = req.body || {};
    const result = await getPlaylistOutlineFromTitle(
      moduleTitle || '',
      numModules,
      level,
      contentTypes
    );
    res.json(result);
  } catch (err) {
    logger.error('Get playlist outline failed', err);
    res.status(500).json({ message: err.message || 'Failed to get playlist outline' });
  }
};

/** Generate full module from title + config (multi-section). SSE stream. POST body: moduleName, shortDescription, level, sections, numBlogs, numVideos, numQuizzes, questionsPerQuiz, numEssays, questionsPerEssay */
export const generateModuleFromTitle = async (req, res) => {
  initSSE(res);

  const send = (step, status, message, data) => {
    res.write(`data: ${JSON.stringify({ step, status, message, data })}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  try {
    const {
      moduleName,
      shortDescription,
      level = 'intermediate',
      sections = [],
      numBlogs = 2,
      numVideos = 0,
      numQuizzes = 1,
      questionsPerQuiz = 4,
      numEssays = 1,
      questionsPerEssay = 3,
      videoLanguage: videoLanguageParam = 'en',
    } = req.body || {};
    const videoLanguage = (videoLanguageParam && String(videoLanguageParam).trim().toLowerCase().slice(0, 2)) || 'en';

    if (!moduleName?.trim()) {
      send('error', 'error', 'Module name is required');
      res.end();
      return;
    }

    send('generating', 'started', 'Generating playlist content...');
    const result = await generateFullPlaylistFromTitleAndConfig({
      moduleName: moduleName.trim(),
      shortDescription: (shortDescription || '').trim(),
      level: ['beginner', 'intermediate', 'advanced'].includes(level) ? level : 'intermediate',
      sections: Array.isArray(sections) ? sections : [],
      numBlogs: Math.max(0, Number(numBlogs) || 2),
      numVideos: Math.max(0, Number(numVideos) || 2),
      numQuizzes: Math.max(0, Number(numQuizzes) || 1),
      questionsPerQuiz: Math.min(10, Math.max(2, Number(questionsPerQuiz) || 4)),
      numEssays: Math.max(0, Number(numEssays) || 1),
      questionsPerEssay: Math.min(8, Math.max(1, Number(questionsPerEssay) || 3)),
      videoLanguage,
      onProgress: (msg) => send('generating', 'started', msg),
    });

    send('generating', 'completed', 'Playlist generated');
    send('cover_image', 'started', 'Finding cover image...');
    let coverImageFile = null;
    try {
      coverImageFile = await fetchCoverImage(result.moduleName);
    } catch (err) {
      logger.warn('Cover image fetch failed', err);
    }
    send('cover_image', 'completed', coverImageFile ? 'Done' : 'Skipped');

    send('saving', 'started', 'Saving module...');
    const estimatedDuration = calculateEstimatedDuration(result.playlist);
    const moduleBody = {
      moduleName: result.moduleName,
      shortDescription: result.shortDescription || result.moduleName,
      playlist: result.playlist,
      status: 'draft',
      estimatedDuration,
      coverImageFile,
    };
    const saved = await createTrainingModule(moduleBody, req.user);
    send('saving', 'completed', 'Done');
    send('done', 'completed', 'Module created successfully.', { moduleId: saved.id });
  } catch (err) {
    logger.error('Generate from title failed', err);
    send('error', 'error', err.message || 'Generation failed');
  }
  res.end();
};

export const saveModuleWithVideoAssignments = async (req, res) => {
  try {
    const { moduleName, shortDescription, sections, videos, videoAssignments } = req.body;
    if (!moduleName?.trim()) {
      return res.status(400).json({ message: 'moduleName is required' });
    }
    const normalizeContentType = (item) => {
      if (item?.contentType === 'video') return { ...item, contentType: 'youtube-link' };
      return item;
    };
    const mergedPlaylist = [];
    let order = 0;
    const videosBySection = {};
    for (const a of videoAssignments || []) {
      const s = a.sectionIndex ?? a.section;
      if (!videosBySection[s]) videosBySection[s] = [];
      videosBySection[s].push(videos[a.videoIndex]);
    }
    for (let sIdx = 0; sIdx < (sections?.length || 0); sIdx++) {
      const sec = sections[sIdx];
      const items = Array.isArray(sec) ? sec : sec?.items || [];
      for (const item of items) {
        const ct = item?.contentType;
        mergedPlaylist.push({ ...normalizeContentType(item), order: order++ });
        if (ct === 'blog' && videosBySection[sIdx]?.length) {
          for (const v of videosBySection[sIdx]) {
            mergedPlaylist.push({
              contentType: 'youtube-link',
              title: v.title,
              duration: v.duration || 0,
              youtubeUrl: v.youtubeUrl,
              order: order++,
            });
          }
        }
      }
    }
    const estimatedDuration = calculateEstimatedDuration(mergedPlaylist);
    let coverImageFile = null;
    try {
      coverImageFile = await fetchCoverImage(moduleName);
    } catch (err) {
      logger.warn('Cover image fetch failed', err);
    }
    const moduleBody = {
      moduleName: moduleName.trim(),
      shortDescription: (shortDescription || moduleName).trim(),
      playlist: mergedPlaylist,
      status: 'draft',
      estimatedDuration,
      coverImageFile,
    };
    const saved = await createTrainingModule(moduleBody, req.user);
    res.status(201).json(saved);
  } catch (err) {
    logger.error('Save with assignments failed', err);
    res.status(500).json({ message: err.message || 'Failed to save module' });
  }
};

export const fetchVideosFromDocument = async (req, res) => {
  try {
    const { documentText } = req.body || {};
    const ids = extractYouTubeUrlsFromText(documentText || '');
    if (!ids.length) return res.json({ videos: [] });
    const videos = await getVideoDetails(ids);
    res.json({ videos });
  } catch (err) {
    logger.error('Fetch videos from document failed', err);
    res.status(500).json({ message: err.message || 'Failed to fetch videos' });
  }
};

export const enhanceQuiz = async (req, res) => {
  try {
    const { moduleTitle, topic, difficulty, existingQuestions, questionIndices } = req.body || {};
    const result = await enhanceQuizWithAI({
      moduleTitle: moduleTitle || '',
      topic,
      difficulty: difficulty || 'medium',
      existingQuestions: existingQuestions || [],
      questionIndices: questionIndices ?? 'all',
    });
    res.json(result);
  } catch (err) {
    logger.error('Enhance quiz failed', err);
    res.status(500).json({ message: err.message || 'Failed to enhance quiz' });
  }
};

export const enhanceEssay = async (req, res) => {
  try {
    const { moduleTitle, topic, difficulty, existingQuestions, questionIndices } = req.body || {};
    const result = await enhanceEssayWithAI({
      moduleTitle: moduleTitle || '',
      topic,
      difficulty: difficulty || 'medium',
      existingQuestions: existingQuestions || [],
      questionIndices: questionIndices ?? 'all',
    });
    res.json(result);
  } catch (err) {
    logger.error('Enhance essay failed', err);
    res.status(500).json({ message: err.message || 'Failed to enhance Q&A' });
  }
};

export const aiChat = async (req, res) => {
  try {
    const { message, modulePayload } = req.body;
    const result = await refineModuleWithChat({ modulePayload, userMessage: message });
    res.json(result);
  } catch (err) {
    logger.error('AI chat failed', err);
    res.status(500).json({ message: err.message });
  }
};

export const cloneModule = async (req, res) => {
  try {
    const original = await getTrainingModuleById(req.params.moduleId);
    if (!original) return res.status(404).json({ message: 'Module not found' });
    const cloneData = {
      moduleName: `${original.moduleName} (Copy)`,
      shortDescription: original.shortDescription,
      categories: original.categories?.map((c) => c._id || c.id) || [],
      students: original.students?.map((s) => s._id || s.id) || [],
      mentorsAssigned: original.mentorsAssigned?.map((m) => m._id || m.id) || [],
      playlist: original.playlist.map((item) => {
        const p = item.toObject ? item.toObject() : { ...item };
        delete p._id;
        delete p.id;
        return p;
      }),
      status: 'draft',
    };
    if (original.coverImage?.key) {
      cloneData.coverImage = { ...(original.coverImage.toObject ? original.coverImage.toObject() : original.coverImage) };
    }
    const cloned = await TrainingModule.create(cloneData);
    res.status(201).json(cloned);
  } catch (err) {
    logger.error('Clone failed', err);
    res.status(500).json({ message: err.message });
  }
};
