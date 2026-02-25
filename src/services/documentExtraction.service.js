import mammoth from 'mammoth';
import JSZip from 'jszip';
import XLSX from 'xlsx';
import logger from '../config/logger.js';

/**
 * Extract raw text + embedded hyperlinks from PDF buffer.
 * Uses pdfjs-dist to get page text and link annotations.
 * YouTube links found on each page are injected inline so they associate
 * with the correct module when the text is later split by module headers.
 */
async function extractTextFromPdfBuffer(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const pageChunks = [];
  const allYtLinks = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);

    const tc = await page.getTextContent();
    let text = tc.items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('');

    const annotations = await page.getAnnotations();
    const ytLinks = annotations
      .filter((a) => a.subtype === 'Link' && a.url)
      .map((a) => a.url)
      .filter((u) => /youtube\.com\/watch\?v=|youtu\.be\//i.test(u) && !/youtube\.com\/playlist/i.test(u));

    const uniquePageLinks = [...new Set(ytLinks)];
    if (uniquePageLinks.length) {
      text += '\n' + uniquePageLinks.join('\n');
      allYtLinks.push(...uniquePageLinks);
    }

    pageChunks.push(text);
  }

  await doc.destroy();

  let fullText = pageChunks.join('\n');

  fullText = fullText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n?--\s*\d+\s*of\s*\d+\s*--\s*\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (allYtLinks.length) {
    const unique = [...new Set(allYtLinks)];
    fullText += '\n\n[YouTube links from document]:\n' + unique.join('\n');
  }

  return fullText;
}

/** Extract raw text from DOCX buffer. */
async function extractTextFromDocxBuffer(buffer) {
  const input = { buffer };
  const [htmlResult, rawResult, zipResult] = await Promise.all([
    mammoth.convertToHtml(input).catch(() => null),
    mammoth.extractRawText(input).catch(() => null),
    JSZip.loadAsync(buffer).catch(() => null),
  ]);

  let text;
  if (htmlResult?.value) {
    text = htmlResult.value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, '')
      .trim();
  } else {
    text = (rawResult?.value || '').trim();
  }

  let youtubeUrls = [];
  if (zipResult) {
    const relsFile = zipResult.file('word/_rels/document.xml.rels');
    if (relsFile) {
      const relsText = await relsFile.async('text');
      const targets = [...relsText.matchAll(/Target="([^"]+)"/g)].map((m) => m[1]);
      youtubeUrls = targets.filter(
        (u) => /youtube\.com\/watch\?v=|youtu\.be\//i.test(u) && !/youtube\.com\/playlist/i.test(u)
      );
    }
  }
  if (youtubeUrls.length) {
    text += '\n\n[YouTube links from document]:\n' + [...new Set(youtubeUrls)].join('\n');
  }
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Extract raw text from Excel buffer (fallback / simple sheets). */
function extractTextFromExcelBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const texts = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    if (!rows?.length) continue;
    const lines = [];
    for (const row of rows) {
      const cells = row.map((c) => (c != null ? String(c).trim() : '')).filter(Boolean);
      if (cells.length === 0) continue;
      if (cells.length === 1) {
        lines.push(cells[0]);
      } else {
        lines.push(cells.join(' | '));
      }
    }
    if (lines.length) texts.push(lines.join('\n'));
  }
  return texts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function findSheet(sheetNames, patterns) {
  for (const pat of patterns) {
    const found = sheetNames.find((n) => {
      const clean = n.replace(/[\u{1F4FA}\u{1F4DD}\u{1F4D6}\u{2B50}\u{1F4D3}]/gu, '').trim();
      return clean.toLowerCase() === pat.toLowerCase() || n.toLowerCase().includes(pat.toLowerCase());
    });
    if (found) return found;
  }
  return null;
}

function cell(row, col) {
  return row && row[col] != null ? String(row[col]).trim() : '';
}

function extractModuleNumberFromSheetName(name) {
  const m = name.match(/Module\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseQuizOptions(optionsText) {
  if (!optionsText) return [];
  const opts = [];
  const re = /([A-D])\)\s*(.+?)(?=\s*[A-D]\)|$)/gs;
  let m;
  while ((m = re.exec(optionsText)) !== null) {
    opts.push({ letter: m[1].toUpperCase(), text: m[2].trim() });
  }
  return opts;
}

function parseCorrectAnswer(answerText) {
  const m = String(answerText).match(/^([A-D])\)/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Extract structured data from an Excel course file.
 * Reads module sheets, video resources, blog introductions directly from columns.
 * Returns the same shape as extractDocumentForDisplay() so the frontend can use it unchanged.
 */
export function extractStructuredDataFromExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const { SheetNames } = workbook;

  // --- Course Overview ---
  const overviewName = findSheet(SheetNames, ['Course Overview', 'Overview']);
  let courseTitle = '';
  let courseDescription = '';
  if (overviewName) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[overviewName], { header: 1, defval: '' });
    courseTitle = cell(rows[0], 0).replace(/^\s+/, '');
    courseDescription = cell(rows[1], 0).replace(/^\s+/, '');
  }

  // --- Video Resources sheet → map module key → [{title, url}] ---
  const videoSheetName = findSheet(SheetNames, ['Video Resources']);
  const videosByModuleKey = {};
  if (videoSheetName) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[videoSheetName], { header: 1, defval: '' });
    let headerIdx = rows.findIndex((r) => /module/i.test(cell(r, 0)) && /link|url/i.test(cell(r, 2)));
    if (headerIdx < 0) headerIdx = rows.findIndex((r) => /module/i.test(cell(r, 0)));
    for (let i = (headerIdx >= 0 ? headerIdx + 1 : 1); i < rows.length; i++) {
      const modCol = cell(rows[i], 0);
      const titleCol = cell(rows[i], 1);
      const urlCol = cell(rows[i], 2);
      if (!modCol || !urlCol) continue;
      if (/playlist/i.test(urlCol)) continue;
      const modNum = extractModuleNumberFromSheetName(modCol);
      const key = modNum != null ? `module_${modNum}` : modCol.toLowerCase().replace(/\s+/g, '_');
      if (/appendix|recommended|channel/i.test(modCol)) continue;
      if (!videosByModuleKey[key]) videosByModuleKey[key] = [];
      videosByModuleKey[key].push({ title: titleCol, url: urlCol });
    }
  }

  // --- Blog Introductions sheet → map module key → text ---
  const blogSheetName = findSheet(SheetNames, ['Blog Introductions', 'Blog']);
  const blogsByModuleKey = {};
  if (blogSheetName) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[blogSheetName], { header: 1, defval: '' });
    let headerIdx = rows.findIndex((r) => /module/i.test(cell(r, 0)) && /blog|introduction/i.test(cell(r, 1)));
    if (headerIdx < 0) headerIdx = rows.findIndex((r) => /module/i.test(cell(r, 0)));
    for (let i = (headerIdx >= 0 ? headerIdx + 1 : 1); i < rows.length; i++) {
      const modCol = cell(rows[i], 0);
      const blogText = cell(rows[i], 1);
      if (!modCol || !blogText) continue;
      const modNum = extractModuleNumberFromSheetName(modCol);
      const key = modNum != null ? `module_${modNum}` : modCol.toLowerCase().replace(/\s+/g, '_');
      blogsByModuleKey[key] = blogText;
    }
  }

  // --- Module sheets → extract quizzes, essays, description ---
  const moduleSheetNames = SheetNames.filter((n) => /Module\s*\d+/i.test(n));
  const modules = [];
  for (const sheetName of moduleSheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
    if (!rows.length) continue;
    const modNum = extractModuleNumberFromSheetName(sheetName);
    const modKey = modNum != null ? `module_${modNum}` : sheetName.toLowerCase().replace(/\s+/g, '_');
    const moduleTitle = cell(rows[0], 0) || sheetName;
    const cleanTitle = `Module ${modNum}: ${moduleTitle.replace(/^Module\s*\d+\s*[–—-]\s*/i, '').trim()}`;
    const moduleDesc = cell(rows[1], 0) || '';

    // Find quiz header row
    let quizHeaderIdx = -1;
    let longAnswerHeaderIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const c0 = cell(rows[i], 0).toLowerCase();
      if (/quiz.*multiple\s*choice|multiple\s*choice/i.test(c0) || (/q#/i.test(c0) && /question/i.test(cell(rows[i], 1)))) {
        if (quizHeaderIdx < 0) quizHeaderIdx = i;
      }
      if (/long[- ]?answer/i.test(c0)) {
        longAnswerHeaderIdx = i;
      }
    }

    // If we found a "Module Quiz" label but not the actual header row, look for Q# header after it
    if (quizHeaderIdx >= 0 && !/q#/i.test(cell(rows[quizHeaderIdx], 0))) {
      for (let j = quizHeaderIdx + 1; j < rows.length && j < quizHeaderIdx + 3; j++) {
        if (/q#/i.test(cell(rows[j], 0)) && /question/i.test(cell(rows[j], 1))) {
          quizHeaderIdx = j;
          break;
        }
      }
    }

    // Parse quiz questions (rows after header until blank row or long-answer section)
    const quizzes = [];
    if (quizHeaderIdx >= 0) {
      const quizEnd = longAnswerHeaderIdx > quizHeaderIdx ? longAnswerHeaderIdx : rows.length;
      for (let i = quizHeaderIdx + 1; i < quizEnd; i++) {
        const qNum = cell(rows[i], 0);
        const questionText = cell(rows[i], 1);
        const optionsText = cell(rows[i], 2);
        const correctText = cell(rows[i], 3);
        if (!questionText || !optionsText) continue;
        if (/^q#/i.test(qNum) || /^question$/i.test(questionText)) continue;

        const opts = parseQuizOptions(optionsText);
        const correctLetter = parseCorrectAnswer(correctText);

        if (questionText && opts.length >= 2) {
          quizzes.push({
            questionText: questionText.replace(/\s+/g, ' '),
            options: opts.map((o) => ({ text: o.text, isCorrect: o.letter === correctLetter })),
            allowMultipleAnswers: false,
          });
        }
      }
    }

    // Parse long-answer / essay questions
    const essays = [];
    if (longAnswerHeaderIdx >= 0) {
      let essayDataStart = longAnswerHeaderIdx + 1;
      // Skip sub-header row (Q#, Question & Full Answer, ...)
      if (essayDataStart < rows.length && /q#/i.test(cell(rows[essayDataStart], 0))) {
        essayDataStart++;
      }
      for (let i = essayDataStart; i < rows.length; i++) {
        const fullText = cell(rows[i], 1);
        if (!fullText) continue;
        const qMatch = fullText.match(/^Q:\s*(.+?)(?:\n\n|\nA:)/s);
        const aMatch = fullText.match(/\nA:\s*([\s\S]+)$/);
        if (qMatch) {
          essays.push({
            questionText: qMatch[1].trim().replace(/\s+/g, ' '),
            expectedAnswer: aMatch ? aMatch[1].trim() : '',
          });
        } else {
          const lines = fullText.split('\n').filter((l) => l.trim());
          if (lines.length > 0) {
            essays.push({
              questionText: lines[0].replace(/^Q:\s*/i, '').trim().replace(/\s+/g, ' '),
              expectedAnswer: lines.slice(1).join('\n').replace(/^A:\s*/i, '').trim(),
            });
          }
        }
      }
    }

    // Get videos and blog for this module
    const modVideos = videosByModuleKey[modKey] || [];
    const videoUrls = modVideos.map((v) => v.url).filter((u) => /youtube\.com|youtu\.be/i.test(u));
    const blogText = blogsByModuleKey[modKey] || moduleDesc || '';

    const sectionOrder = ['video', 'blog', 'quiz', 'essay'];
    const blogParas = blogText ? blogText.split(/\n\n+/).filter((p) => p.trim()) : [];
    if (blogParas.length === 0 && blogText.trim()) blogParas.push(blogText.trim());

    modules.push({
      title: cleanTitle,
      videos: videoUrls,
      blogs: blogParas.length > 0 ? blogParas : [],
      quizzes: quizzes.map((q) => ({
        questionText: q.questionText,
        options: q.options,
      })),
      essays: essays.map((e) => ({
        questionText: e.questionText,
        expectedAnswer: e.expectedAnswer,
      })),
      sectionOrder,
    });
  }

  // Collect all YouTube URLs
  const allYoutubeUrls = [...new Set(modules.flatMap((m) => m.videos))];

  // Generate a normalized text summary for downstream use
  const textParts = [];
  if (courseTitle) textParts.push(courseTitle);
  if (courseDescription) textParts.push(courseDescription);
  for (const mod of modules) {
    textParts.push(`\n${mod.title}`);
    if (mod.blogs.length) textParts.push(`Blogs\n${mod.blogs.join('\n')}`);
    if (mod.quizzes.length) {
      textParts.push('Quizzes');
      mod.quizzes.forEach((q, i) => {
        textParts.push(`Q${i + 1}. ${q.questionText}`);
        q.options.forEach((o) => textParts.push(`${o.isCorrect ? '✅ ' : ''}${o.text}`));
      });
    }
    if (mod.essays.length) {
      textParts.push('Long-answer questions');
      mod.essays.forEach((e, i) => textParts.push(`${i + 1}. ${e.questionText}`));
    }
    if (mod.videos.length) {
      textParts.push('Videos');
      mod.videos.forEach((u) => textParts.push(u));
    }
  }
  const normalizedText = textParts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    normalizedText,
    extractedByModule: modules,
    youtubeUrls: allYoutubeUrls,
    documentTitle: courseTitle,
    isStructuredExcel: true,
  };
}

/**
 * Extract document title from the first page of raw text.
 * Stops at "Course Documentation" (or similar) — nothing below that is included.
 * Example: "Python Programming\nBasics & Fundamentals" → "Python Programming Basics & Fundamentals"
 * @param {string} rawText - Raw text from document
 * @returns {string} Extracted title, or empty string if not found
 */
export function extractDocumentTitle(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  const lines = rawText.split(/\r?\n/).map((l) => l.trim());
  let endIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();
    if (/course\s*documentation|course\s*document/.test(line)) {
      endIdx = i;
      break;
    }
  }
  const titleLines = lines.slice(0, endIdx).filter((l) => l.length > 1);
  // Drop leading junk (e.g. alt text, very short lines) and keep prominent title
  const cleaned = [];
  for (const l of titleLines) {
    if (l.length < 3) continue;
    if (/^(includes?|level|pace|self-?paced|beginner|intermediate|advanced)[:\s]?/i.test(l)) break;
    cleaned.push(l);
  }
  const title = cleaned.join(' ').replace(/\s+/g, ' ').trim();
  return title.slice(0, 200);
}

/**
 * Extract raw text from uploaded file buffer.
 * @param {Buffer} buffer - File buffer
 * @param {string} mimeType - MIME type
 * @param {string} filename - Original filename
 * @returns {Promise<string>} Raw extracted text
 */
export async function extractRawTextFromFile(buffer, mimeType, filename) {
  const ext = filename?.split('.').pop()?.toLowerCase() || '';
  if (mimeType === 'application/pdf' || ext === 'pdf') {
    return extractTextFromPdfBuffer(buffer);
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    return extractTextFromDocxBuffer(buffer);
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel' ||
    ext === 'xlsx' ||
    ext === 'xls'
  ) {
    return extractTextFromExcelBuffer(buffer);
  }
  throw new Error('Unsupported file type. Use PDF, DOCX, or Excel (.xlsx, .xls).');
}
