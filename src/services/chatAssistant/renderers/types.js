// uat.dharwin.backend/src/services/chatAssistant/renderers/types.js
//
// Canonical structured-response envelope. Mirror these shapes in
// `uat.dharwin.frontend/shared/types/chatResponse.ts`. Keep both in sync.
//
// Wire contract: backend always emit { reply, blocks, meta }. `reply` stay
// markdown for backward-compat, copy/paste, a11y, and old clients that don't
// branch on `blocks`. `blocks` carry the structured render plan.

/**
 * @typedef {'neutral'|'info'|'success'|'warn'|'danger'} Tone
 *
 * @typedef {object} Column
 * @property {string} key
 * @property {string} label
 * @property {'left'|'right'|'center'} [align]
 * @property {'primary'|'secondary'} [priority]
 * @property {'date'|'number'|'badge'|'currency'|'mono'} [format]
 *
 * @typedef {Record<string, string|number|{v:string, tone?:Tone}>} Row
 *
 * @typedef {object} Pagination
 * @property {number} from
 * @property {number} to
 * @property {number} total
 * @property {boolean} hasMore
 *
 * @typedef {{ type:'text', md:string }} TextBlock
 * @typedef {{ type:'heading', level:1|2|3, text:string }} HeadingBlock
 * @typedef {{ type:'callout', tone:Tone, md:string, icon?:string }} CalloutBlock
 * @typedef {{ type:'kv', title?:string, pairs:{label:string,value:string,tone?:Tone}[] }} KVBlock
 * @typedef {{ type:'badge_row', chips:{label:string,tone:Tone,count?:number}[] }} BadgeRowBlock
 * @typedef {{
 *   type:'table',
 *   id:string,
 *   title?:string,
 *   columns:Column[],
 *   rows:Row[],
 *   pagination?:Pagination,
 *   layout?:'auto'|'table'|'cards'
 * }} TableBlock
 * @typedef {{
 *   type:'cards',
 *   id:string,
 *   layout:'employee'|'job'|'project'|'generic',
 *   items:object[]
 * }} CardsBlock
 * @typedef {{
 *   type:'group',
 *   title:string,
 *   collapsible?:boolean,
 *   defaultOpen?:boolean,
 *   blocks:Block[]
 * }} GroupBlock
 * @typedef {{
 *   type:'fallback',
 *   kind:string,
 *   title:string,
 *   reasons:string[],
 *   suggestions:string[],
 *   query?:string
 * }} FallbackBlock
 * @typedef {{
 *   type:'actions',
 *   buttons:{ label:string, intent:'query'|'navigate', payload:string }[]
 * }} ActionsBlock
 *
 * @typedef {TextBlock|HeadingBlock|CalloutBlock|KVBlock|BadgeRowBlock|
 *           TableBlock|CardsBlock|GroupBlock|FallbackBlock|ActionsBlock} Block
 *
 * @typedef {object} Meta
 * @property {string|null} [kind]
 * @property {number|null} [total]
 * @property {boolean} [deterministic]
 * @property {number|null} [tookMs]
 *
 * @typedef {object} ChatResponse
 * @property {string} reply
 * @property {Block[]} blocks
 * @property {Meta} meta
 */

export const TONES = Object.freeze({
  neutral: 'neutral',
  info:    'info',
  success: 'success',
  warn:    'warn',
  danger:  'danger',
});

/**
 * Build the canonical envelope. Always normalise so callers don't have to
 * remember to set defaults.
 *
 * @param {{ reply?:string, blocks?:Block[], meta?:Partial<Meta> }} [input]
 * @returns {ChatResponse}
 */
export function envelope(input = {}) {
  const { reply = '', blocks = [], meta = {} } = input;
  return {
    reply: typeof reply === 'string' ? reply : String(reply ?? ''),
    blocks: Array.isArray(blocks) ? blocks : [],
    meta: {
      kind: meta.kind ?? null,
      total: typeof meta.total === 'number' ? meta.total : null,
      deterministic: !!meta.deterministic,
      tookMs: typeof meta.tookMs === 'number' ? meta.tookMs : null,
    },
  };
}
