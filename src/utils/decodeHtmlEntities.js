/**
 * Reverse HTML entity encoding applied by xss-clean (xss-filters inHTMLData) on JSON bodies.
 * Used for rich-text fields that must remain real HTML (templates, signatures, message bodies).
 */
export function decodeHtmlEntities(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  if (!str.includes('&')) return str;
  const ampPlaceholder = '__DHARWIN_AMP_PLACEHOLDER__';
  const out = str
    .replace(/&amp;/g, ampPlaceholder)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
  return out.split(ampPlaceholder).join('&');
}

/** @param {Record<string, unknown>} json */
export function decodeEmailTemplateJson(json) {
  if (!json || typeof json !== 'object') return json;
  const out = { ...json };
  if (typeof out.bodyHtml === 'string') {
    out.bodyHtml = decodeHtmlEntities(out.bodyHtml);
  }
  return out;
}

/** @param {Record<string, unknown>} json */
export function decodeEmailSignatureJson(json) {
  if (!json || typeof json !== 'object') return json;
  const out = { ...json };
  if (typeof out.html === 'string') {
    out.html = decodeHtmlEntities(out.html);
  }
  return out;
}
