import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import PDFDocument from 'pdfkit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Same asset as frontend `public/assets/images/dharwin-offer-letter-logo.png` (kept in-repo under src/assets). */
const OFFER_LETTER_LOGO_CANDIDATES = [
  path.join(__dirname, '../assets/offer-letters/dharwin-offer-letter-logo.png'),
  path.join(process.cwd(), 'src/assets/offer-letters/dharwin-offer-letter-logo.png'),
];

const resolveOfferLetterLogoPng = () => {
  for (const p of OFFER_LETTER_LOGO_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
};

/** CEO ink signature (Harvinder) — same asset as frontend `public/assets/images/ceo-signature-harvinder.png`. */
const OFFER_LETTER_CEO_SIGNATURE_CANDIDATES = [
  path.join(__dirname, '../assets/offer-letters/ceo-signature-harvinder.png'),
  path.join(process.cwd(), 'src/assets/offer-letters/ceo-signature-harvinder.png'),
];

const resolveOfferCeoSignaturePng = () => {
  for (const p of OFFER_LETTER_CEO_SIGNATURE_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
};

const BRAND = 'Dharwin Business Solutions LLC';
const SUPPORT = 'support@dharwinbusinesssolutions.com';
const EVERIFY = 'E-Verify Company ID: 2702244 | EIN: 38-4356712';

/** ~1" margins to match typical Word letter */
const MARGIN = 72;
const PAGE_W = 612;
const PAGE_H = 792; // US Letter, PDFKit points
const CONTENT_W = PAGE_W - MARGIN * 2;
/** Band at page bottom for repeating letter footer (rule + three columns). */
const REPEAT_FOOTER_H = 52;
/** Body content must stay above this y so the stacked footer is never overlapped. */
const CONTENT_MAX_Y = PAGE_H - MARGIN - REPEAT_FOOTER_H;
/** Match `offer-letter-generator.module.css` `.letter` / `.letterBody` */
const BODY_PT = 11;
const SECTION_TITLE_PT = 11.5;
const SUBJECT_PT = 12.5;
const SMALL_PT = 9.5;
/** ~22px at 96dpi ≈ 16.5pt — matches `.bulletList` padding-left */
const BULLET_INSET = 16;
/** Match `.letterSubject` / brand */
const SUBJECT_BLUE = '#1e4080';
const BRAND_BLUE = '#1e4080';
const BRAND_GREEN = '#4a9e4a';
const SECTION_HIGHLIGHT = '#fff176';

const FONT = 'Times-Roman';
const FONT_BOLD = 'Times-Bold';

/** Rupee + tight "INRword" fixes for PDF (Times lacks ₹; user narratives may omit spaces). */
const sanitizeCompensationForPdf = (s) =>
  String(s || '')
    .replace(/\u20B9/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\bINR([A-Za-z])/g, 'INR $1')
    .replace(/\s+/g, ' ')
    .trim();

const ordinalDay = (n) => {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return `${n}st`;
  if (j === 2 && k !== 12) return `${n}nd`;
  if (j === 3 && k !== 13) return `${n}rd`;
  return `${n}th`;
};

const formatStartDate = (d) => {
  if (!d) return 'TBD';
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return 'TBD';
  const mon = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(x);
  return `${ordinalDay(x.getDate())} ${mon}, ${x.getFullYear()}`;
};

const formatUsDate = (d) => {
  if (!d) return '—';
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(x);
};

/** Matches frontend `fmtDateLong` when letter date is set. */
const formatLetterDateLong = (d) => {
  if (!d) return '—';
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(x);
};

const jobTypeLabel = (ctx) => {
  if (ctx.isIntern) return 'Training / Unpaid Internship (Full Time)';
  if (ctx.jobType === 'FT_40') return 'Full-Time (40 Hours per Week)';
  if (ctx.jobType === 'PT_25') return 'Part-Time (25 Hours per Week)';
  return 'Full-Time (40 Hours per Week)';
};

/**
 * Header matching on-screen preview (`letterHeader` + `letterDivider`).
 * All job types use the same PNG as the web preview when the file is present.
 */
const drawLetterheadLikePreview = (doc, yStart) => {
  const splitX = MARGIN + CONTENT_W * 0.5;
  const rightPad = MARGIN + CONTENT_W - splitX - 8;
  const leftW = Math.max(120, splitX - MARGIN - 8);
  const fitH = 56;
  let y = yStart;
  let leftBottom = y + 42;

  const logoPath = resolveOfferLetterLogoPng();
  if (logoPath) {
    try {
      doc.image(logoPath, MARGIN, y, { fit: [leftW, fitH] });
      leftBottom = y + fitH;
    } catch {
      doc.font(FONT_BOLD).fontSize(14).fillColor(BRAND_BLUE).text('Dharwin', MARGIN, y);
      doc.font(FONT_BOLD).fontSize(11).fillColor(BRAND_GREEN).text('Business Solutions', MARGIN, y + 16);
      leftBottom = y + 42;
    }
  } else {
    doc.font(FONT_BOLD).fontSize(14).fillColor(BRAND_BLUE).text('Dharwin', MARGIN, y);
    doc.font(FONT_BOLD).fontSize(11).fillColor(BRAND_GREEN).text('Business Solutions', MARGIN, y + 16);
    leftBottom = y + 42;
  }

  let ry = y;
  doc.font(FONT).fontSize(SMALL_PT).fillColor('#222222');
  doc.text('Support@dharwinbusinesssolutions.com', splitX + 8, ry, { width: rightPad, lineGap: 4 });
  ry = doc.y + 2;
  doc.text('30N Gould St, STE R, Sheridan, WY, 82801', splitX + 8, ry, { width: rightPad, lineGap: 4 });
  ry = doc.y + 2;
  doc.text('www.dharwinbusinesssolutions.com', splitX + 8, ry, { width: rightPad });
  y = Math.max(leftBottom, doc.y + 6);
  doc.save();
  doc.strokeColor('#222222').lineWidth(1.5);
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).stroke();
  doc.restore();
  doc.fillColor('#000000');
  return y + 12;
};

/** Rule + three columns pinned to the bottom of the *current* page (matches `.letterFooter`, pic 4). */
const drawFooterAtBottomOfCurrentPage = (doc) => {
  const lineY = PAGE_H - MARGIN - 34;
  const colY = lineY + 10;
  doc.save();
  doc.strokeColor('#222222').lineWidth(1.5);
  doc.moveTo(MARGIN, lineY).lineTo(MARGIN + CONTENT_W, lineY).stroke();
  doc.restore();
  const colW = CONTENT_W / 3;
  doc.font(FONT).fontSize(9).fillColor('#333333');
  doc.text('support@dharwinbusinesssolutions.com', MARGIN, colY, { width: colW - 6, align: 'left' });
  doc.text('30 N Gould St, STE R Sheridan, WY82801, USA', MARGIN + colW, colY, { width: colW - 6, align: 'center' });
  doc.text('Website: www.dharwinbusinesssolutions.com', MARGIN + 2 * colW, colY, { width: colW - 6, align: 'right' });
  doc.fillColor('#000000');
};

/** Repeat footer on the page we are leaving, then new page + letterhead (pic 3 header on every sheet). */
const addContinuationPage = (doc) => {
  drawFooterAtBottomOfCurrentPage(doc);
  doc.addPage();
  return drawLetterheadLikePreview(doc, MARGIN) + 10;
};

const drawParagraph = (doc, text, y, w = CONTENT_W, opts = {}) => {
  const { fontSize = BODY_PT, bold = false, justify = true } = opts;
  if (y > CONTENT_MAX_Y - 48) {
    y = addContinuationPage(doc);
  }
  doc.font(bold ? FONT_BOLD : FONT).fontSize(fontSize);
  doc.text(text, MARGIN, y, {
    width: w,
    align: justify ? 'justify' : 'left',
    lineGap: Math.round(BODY_PT * 0.45),
  });
  return doc.y + 4;
};

const drawBullets = (doc, items, y) => {
  let pos = y;
  doc.font(FONT).fontSize(BODY_PT);
  const x = MARGIN + BULLET_INSET;
  const lineGap = Math.round(BODY_PT * 0.35);
  for (const it of items || []) {
    const t = (it || '').trim();
    if (!t) continue;
    if (pos > CONTENT_MAX_Y - 36) {
      pos = addContinuationPage(doc);
    }
    doc.text(`• ${t}`, x, pos, { width: CONTENT_W - BULLET_INSET, align: 'justify', lineGap });
    pos = doc.y + 2;
  }
  return pos;
};

/** Bullet + bold label + value (matches Word “Position Details” / supervisor lists) */
const drawBulletedLabeled = (doc, label, value, y) => {
  if (y > CONTENT_MAX_Y - 36) {
    y = addContinuationPage(doc);
  }
  const x = MARGIN + BULLET_INSET;
  doc.font(FONT_BOLD).fontSize(BODY_PT).fillColor('#000000');
  const sep = String(label).endsWith('-') ? ' ' : ': ';
  const w = CONTENT_W - BULLET_INSET;
  doc.text(`• ${label}${sep}`, x, y, { width: w, continued: true, lineBreak: false });
  doc.font(FONT).text(String(value ?? '—'), { width: w, lineGap: Math.round(BODY_PT * 0.35) });
  return doc.y + 4;
};

/** Compensation line: bullet + narrative with currency amounts in bold (Word template) */
const drawCompensationBullet = (doc, text, y) => {
  if (y > CONTENT_MAX_Y - 36) {
    y = addContinuationPage(doc);
  }
  const s =
    sanitizeCompensationForPdf(text) || 'As stated in your formal compensation discussion.';
  const parts = s.split(/(\$[\d,]+ USD|[\d,]+ INR)/g).filter((p) => p !== '');
  const x = MARGIN + BULLET_INSET;
  const w = CONTENT_W - BULLET_INSET;
  doc.font(FONT_BOLD).fontSize(BODY_PT).fillColor('#000000').text('• ', x, y, { width: w, continued: true, lineBreak: false });
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    const isAmt = /^\$[\d,]+ USD$/.test(p) || /^[\d,]+ INR$/.test(p);
    doc.font(isAmt ? FONT_BOLD : FONT).text(p, {
      width: w,
      continued: i < parts.length - 1,
      lineGap: Math.round(BODY_PT * 0.35),
    });
  }
  return doc.y + 4;
};

/** Matches frontend ELIGIBILITY_MAP.opt_regular.unpaid (Word template). */
const DEFAULT_INTERN_ELIGIBILITY = [
  'As per U.S. immigration regulations, this training position is aligned with your F-1 Optional Practical Training (OPT) authorization. The responsibilities outlined above are directly related to your major field of study, and we are prepared to support any necessary documentation required for your Designated School Official (DSO) or SEVIS reporting, including confirming supervision, training plans, and role alignment.',
];

/** Matches paid Regular OPT template (three bullets). */
const DEFAULT_PAID_ELIGIBILITY = [
  'As per the Immigration Reform and Control Act, you are required to present documentation verifying your identity and employment authorization on your first day of employment.',
  'It is our understanding that you are currently authorized to work in the United States under the F-1 Post-Completion OPT program (Regular OPT).',
  'This offer is valid subject to your continued valid employment authorization.',
];

/** Inline yellow + underline — matches `.sectionTitleHl` (not full-width bar). */
function drawSectionTitle(doc, title, y) {
  if (y > CONTENT_MAX_Y - 40) {
    y = addContinuationPage(doc);
  }
  const fs = SECTION_TITLE_PT;
  const padX = 2;
  doc.font(FONT_BOLD).fontSize(fs);
  const textW = doc.widthOfString(title);
  const barH = fs + 4;
  doc.save();
  doc.rect(MARGIN, y, textW + padX * 2, barH).fill(SECTION_HIGHLIGHT);
  doc.restore();
  doc.fillColor('#111111');
  doc.font(FONT_BOLD).fontSize(fs).text(title, MARGIN + padX, y + 1, { underline: true });
  return y + barH + 8;
}

/** Bold + underline, no yellow bar (Employment Eligibility in Word template). */
function drawSectionTitlePlain(doc, title, y) {
  if (y > CONTENT_MAX_Y - 40) {
    y = addContinuationPage(doc);
  }
  doc.fillColor('#111111');
  doc
    .font(FONT_BOLD)
    .fontSize(SECTION_TITLE_PT)
    .text(title, MARGIN, y, { width: CONTENT_W, underline: true, lineGap: 0 });
  return doc.y + 8;
}

/** Centered banner — matches frontend “Offer of Employment” badge. */
function drawOfferEmploymentBanner(doc, y) {
  if (y > CONTENT_MAX_Y - 50) {
    y = addContinuationPage(doc);
  }
  const barH = 24;
  const padY = 1;
  doc.save();
  doc.rect(MARGIN, y - padY, CONTENT_W, barH).fill(SECTION_HIGHLIGHT);
  doc.lineWidth(2).strokeColor('#f5c518');
  doc.rect(MARGIN, y - padY, CONTENT_W, barH).stroke();
  doc.restore();
  doc.fillColor('#111111');
  doc.font(FONT_BOLD).fontSize(12).text('Offer of Employment', MARGIN + 4, y + 5, {
    width: CONTENT_W - 8,
    align: 'center',
  });
  return y + barH + 12;
}

function drawSupervisorBlock(doc, y, ctx) {
  if (!(ctx.supervisor && (ctx.supervisor.firstName || ctx.supervisor.lastName))) return y;
  y = drawSectionTitle(doc, 'Supervisor details', y);
  const sup = ctx.supervisor;
  y = drawBulletedLabeled(doc, 'First name-', sup.firstName || '—', y);
  y = drawBulletedLabeled(doc, 'Last Name-', sup.lastName || '—', y);
  if (sup.phone) y = drawBulletedLabeled(doc, 'Number-', sup.phone, y);
  if (sup.email) y = drawBulletedLabeled(doc, 'Email-', sup.email, y);
  return y + 6;
}

/** Place CEO ink above the line: wide/cropped assets stay legible (min h + clip if width overflows column). */
function drawCeoSignatureImageInColumn(doc, leftX, yL, colW, ceoSigPath) {
  const MAX_H = 56;
  const MIN_H = 40;
  const img = doc.openImage(ceoSigPath);
  let drawW = colW;
  let drawH = (img.height / img.width) * drawW;
  if (drawH > MAX_H) {
    drawH = MAX_H;
    drawW = (img.width / img.height) * drawH;
  } else if (drawH < MIN_H) {
    drawH = MIN_H;
    drawW = (img.width / img.height) * drawH;
  }
  if (drawW > colW + 0.5) {
    const clipH = drawH;
    doc.save();
    doc.rect(leftX, yL, colW, clipH).clip();
    const ix = leftX + (colW - drawW) / 2;
    doc.image(ceoSigPath, ix, yL, { width: drawW, height: drawH });
    doc.restore();
    yL += clipH + 6;
  } else {
    doc.image(ceoSigPath, leftX, yL, { width: drawW, height: drawH });
    yL += drawH + 6;
  }
  return yL;
}

function drawSignatureTwoColumn(doc, y, ctx) {
  /** Entire two-column block must share one page (right uses same y as “For” line; no page breaks mid-left). */
  if (y > CONTENT_MAX_Y - 200) {
    y = addContinuationPage(doc);
  }
  const colW = (CONTENT_W - 24) / 2;
  const leftX = MARGIN;
  const rightX = MARGIN + colW + 24;
  const dateStr = ctx.letterDateDisplay || formatUsDate(new Date());
  const yStart = y;

  const flushLine = (x, yRef, rows) => {
    let yy = yRef;
    for (const [text, bold] of rows) {
      if (yy > CONTENT_MAX_Y - 30) {
        yy = addContinuationPage(doc);
      }
      doc.font(bold ? FONT_BOLD : FONT).fontSize(BODY_PT).text(text, x, yy, { width: colW, lineGap: 2 });
      yy = doc.y + 4;
    }
    return yy;
  };

  const rightRows = [
    ['Accepted and Agreed:', true],
    ['_____________________________', false],
    [ctx.fullName, false],
    [ctx.positionTitle, false],
    [`Date: ${dateStr}`, false],
  ];

  /** Left: “For…” line, CEO signature image, rule, name / title / date (all bold). */
  let yL = yStart;
  doc.fillColor('#111111');
  doc.font(FONT_BOLD).fontSize(BODY_PT).text('For Dharwin Business Solutions LLC', leftX, yL, { width: colW, lineGap: 2 });
  yL = doc.y + 4;

  const ceoSigPath = resolveOfferCeoSignaturePng();
  if (ceoSigPath) {
    try {
      yL = drawCeoSignatureImageInColumn(doc, leftX, yL, colW, ceoSigPath);
    } catch {
      yL += 4;
    }
  } else {
    yL += 4;
  }

  doc.save();
  doc.strokeColor('#222222').lineWidth(0.9);
  doc.moveTo(leftX, yL).lineTo(leftX + colW, yL).stroke();
  doc.restore();
  yL += 8;

  for (const line of ['Dhariwal Harvinder Singh', 'CEO & Founder', `Date: ${dateStr}`]) {
    doc.font(FONT_BOLD).fontSize(BODY_PT).text(line, leftX, yL, { width: colW, lineGap: 2 });
    yL = doc.y + 4;
  }

  const yR = flushLine(rightX, yStart, rightRows);
  return Math.max(yL, yR);
}

/** Opening paragraph with bold E-Verify / ID clause (matches internship styling). */
function drawOpeningIntro(doc, y, ctx) {
  if (y > CONTENT_MAX_Y - 60) {
    y = addContinuationPage(doc);
  }
  const fs = BODY_PT;
  const lg = Math.round(BODY_PT * 0.45);
  const w = CONTENT_W;
  const cont = { width: w, lineGap: lg, align: 'justify' };
  doc.fillColor('#111111');
  if (ctx.isIntern) {
    const a = `We are pleased to extend to you an offer for an unpaid training opportunity at ${BRAND}, a registered E-Verify employer (`;
    const b = EVERIFY;
    const c = `). This position is intended to provide you with valuable practical experience in a professional work environment aligned with your academic training and career goals.`;
    doc.font(FONT).fontSize(fs).text(a, MARGIN, y, { ...cont, continued: true, lineBreak: false });
    doc.font(FONT_BOLD).text(b, { ...cont, continued: true, lineBreak: false });
    doc.font(FONT).text(c, cont);
  } else {
    const a = `${BRAND}, a registered E-Verify employer (`;
    const b = 'Company Identification Number: 2702244, EIN: 38-4356712';
    const c = `), appreciates your interest in employment opportunities with our organization. After reviewing your qualifications and experience, we are pleased to offer you a position with our company under the terms outlined below.`;
    doc.font(FONT).fontSize(fs).text(a, MARGIN, y, { ...cont, continued: true, lineBreak: false });
    doc.font(FONT_BOLD).text(b, { ...cont, continued: true, lineBreak: false });
    doc.font(FONT).text(c, cont);
  }
  return doc.y + 10;
}

function drawUnifiedOfferBody(doc, y, ctx) {
  y = drawOpeningIntro(doc, y, ctx);
  y += 6;

  y = drawSectionTitle(doc, 'Position Details:', y);
  y = drawBulletedLabeled(doc, 'Job Title', ctx.positionTitle || '—', y);
  y = drawBulletedLabeled(doc, 'Start Date', ctx.startDateText || '—', y);
  y = drawBulletedLabeled(doc, 'Job Type', jobTypeLabel(ctx), y);
  const hoursForPdf = ctx.isIntern
    ? `${ctx.weeklyHours} hours per week`
    : `${[25, 40].includes(ctx.weeklyHours) ? ctx.weeklyHours : ctx.jobType === 'PT_25' ? 25 : 40} hours per week`;
  y = drawBulletedLabeled(doc, 'Hours', hoursForPdf, y);
  y = drawBulletedLabeled(doc, 'Location', ctx.workLocation || 'Remote (USA)', y);
  y += 4;

  y = drawSupervisorBlock(doc, y, ctx);

  y = drawSectionTitle(doc, 'Compensation:', y);
  if (ctx.isIntern) {
    y = drawBullets(doc, [
      'This is an unpaid training internship. There is no monetary compensation, stipend, or employee benefits associated with this position. There is no guarantee of future paid employment.',
    ], y);
  } else {
    const comp =
      (ctx.compensation && ctx.compensation.trim()) || 'As stated in your formal compensation discussion.';
    y = drawCompensationBullet(doc, comp, y);
  }
  y += 8;

  y = drawSectionTitle(doc, ctx.isIntern ? 'Roles & Responsibilities:' : 'Position Overview:', y);
  const overviewLead = ctx.isIntern
    ? `As a ${ctx.positionTitle}, you will receive guided exposure and training in areas including, but not limited to:`
    : `As a ${ctx.positionTitle}, your responsibilities will include but are not limited to:`;
  y = drawParagraph(doc, overviewLead, y);
  y = drawBullets(doc, ctx.roleBullets, y);
  if (ctx.isIntern) {
    y += 4;
    y = drawParagraph(doc, 'All tasks will be non-billable, supervised, and training-oriented.', y);
  }
  y += 6;

  if (ctx.isIntern && ctx.trainingBullets && ctx.trainingBullets.length) {
    y = drawSectionTitle(doc, 'Training & Learning Outcomes:', y);
    y = drawParagraph(doc, 'This internship will focus on enhancing your knowledge in:', y);
    y = drawBullets(doc, ctx.trainingBullets, y);
    y += 6;
  }

  if (ctx.academicNote && String(ctx.academicNote).trim()) {
    y = drawParagraph(doc, ctx.academicNote.trim(), y);
    y += 6;
  }

  y = ctx.isIntern
    ? drawSectionTitlePlain(doc, 'Employment Eligibility:', y)
    : drawSectionTitle(doc, 'Employment Eligibility:', y);
  const eligRaw = Array.isArray(ctx.eligibilityLines) ? ctx.eligibilityLines : [];
  const eligSanitized = eligRaw.map((s) => String(s || '').trim()).filter(Boolean);
  const elig =
    eligSanitized.length > 0
      ? eligSanitized
      : ctx.isIntern
        ? DEFAULT_INTERN_ELIGIBILITY
        : DEFAULT_PAID_ELIGIBILITY;
  y = drawBullets(doc, elig, y);
  y += 6;

  if (ctx.isIntern) {
    y = drawSectionTitlePlain(doc, 'Important Notes', y);
    y = drawBullets(
      doc,
      [
        `This is a remote, voluntary unpaid internship for ${ctx.weeklyHours} hours per week.`,
        'The internship is intended purely for skill development and professional experience.',
        'There is no monetary compensation and no guarantee of future paid employment.',
        'You may discontinue participation at any time.',
        'This role does not constitute an employment relationship under the Fair Labor Standards Act (FLSA).',
      ],
      y,
    );
    y += 8;
    y = drawParagraph(
      doc,
      `We are confident that this experience will provide valuable exposure to real-world applications and help you build a strong professional foundation. If you agree with the terms outlined above, please sign and return a copy of this letter to ${SUPPORT} to confirm your acceptance. We look forward to working with you and supporting your professional journey.`,
      y,
    );
    y += 12;
  } else {
    y = drawSectionTitle(doc, 'Employment Status:', y);
    y = drawBullets(
      doc,
      [
        'This offer of employment does not constitute a contract. Your employment with Dharwin Business Solutions LLC will be at-will, meaning that either party may terminate the employment relationship at any time, with or without cause or notice.',
        'We are confident that your technical expertise and dedication will contribute significantly to our ongoing projects and SaaS development initiatives.',
        `Please confirm your acceptance of this offer by signing below and returning a scanned copy to ${SUPPORT}`,
      ],
      y,
    );
    y += 10;
  }

  y = drawSignatureTwoColumn(doc, y, ctx);
  return y;
}

/**
 * @param {object} ctx
 * @param {boolean} ctx.isIntern
 * @param {string} [ctx.jobType] FT_40 | PT_25 | INTERN_UNPAID
 * @param {number} ctx.weeklyHours
 * @param {string} ctx.fullName
 * @param {string} ctx.address
 * @param {string} ctx.positionTitle
 * @param {string} ctx.startDateText
 * @param {string} [ctx.workLocation]
 * @param {string[]} ctx.roleBullets
 * @param {string[]} [ctx.trainingBullets]
 * @param {string} [ctx.compensation]
 * @param {object} [ctx.supervisor]
 * @param {string} [ctx.academicNote]
 * @param {string[]} [ctx.eligibilityLines]
 * @param {Date} [ctx.letterDate]
 */
const buildOfferLetterPdfBuffer = (ctx) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: MARGIN,
      bufferPages: true,
      autoFirstPage: true,
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    try {
      let y = drawLetterheadLikePreview(doc, MARGIN);
      y += 2;

      const hasExplicitLetterDate = Boolean(ctx.letterDate);
      const letterDateObj = hasExplicitLetterDate ? new Date(ctx.letterDate) : new Date();
      const dateStr = hasExplicitLetterDate
        ? formatLetterDateLong(letterDateObj)
        : formatUsDate(letterDateObj);
      ctx.letterDateDisplay = dateStr;

      doc.font(FONT_BOLD).fontSize(SUBJECT_PT).fillColor(SUBJECT_BLUE);
      doc.text('Sub: Offer Letter', MARGIN, y, { width: CONTENT_W, align: 'center', underline: true });
      y = doc.y + 10;

      doc.font(FONT).fontSize(BODY_PT).fillColor('#000000');
      doc.text(`Date: ${dateStr}`, MARGIN, y, { width: CONTENT_W, align: 'right' });
      y = doc.y + 14;

      y = drawOfferEmploymentBanner(doc, y);

      doc.fillColor('#000000');
      const addrW = CONTENT_W;
      doc.font(FONT_BOLD).text('To:', MARGIN, y, { width: addrW, continued: true, lineBreak: false });
      doc.font(FONT).text(` ${ctx.fullName || '—'}`, { width: addrW, lineGap: 3 });
      y = doc.y + 4;
      doc.font(FONT_BOLD).text('Address:', MARGIN, y, { width: addrW, continued: true, lineBreak: false });
      doc.font(FONT).text(` ${ctx.address || '—'}`, { width: addrW, lineGap: 3 });
      y = doc.y + 12;

      doc.font(FONT_BOLD).fillColor('#000000').text(`Hi ${ctx.fullName},`, MARGIN, y);
      y = doc.y + 12;

      y = drawUnifiedOfferBody(doc, y, ctx);
      drawFooterAtBottomOfCurrentPage(doc);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });

export { buildOfferLetterPdfBuffer, formatStartDate, formatUsDate, jobTypeLabel };
