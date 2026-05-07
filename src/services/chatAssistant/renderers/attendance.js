// uat.dharwin.backend/src/services/chatAssistant/renderers/attendance.js
//
// Render `fetch_attendance_summary` retrieval payload as either a
// single-day GroupBlock (KV summary + per-status BadgeRow) or a multi-day
// TableBlock with one row per date. Markdown twin matches legacy
// factRenderer output for single-day so the wire format stay aligned.
//
// Input shape (verbatim from factExtractor.readAttendanceSummary):
//   {
//     total: number,
//     perDay: [{ date: 'YYYY-MM-DD',
//                counts: { Present, Absent, Leave, Holiday, WeekOff, Incomplete } }],
//     notFound?: boolean,
//     needsTimeWindow?: boolean,
//   }

const STATUS_TONES = {
  Present:    'success',
  Absent:     'danger',
  Leave:      'warn',
  Holiday:    'info',
  WeekOff:    'neutral',
  Incomplete: 'warn',
};

const STATUS_ORDER = ['Present', 'Absent', 'Leave', 'Holiday', 'WeekOff', 'Incomplete'];

/**
 * @param {object} data
 * @param {{ queryArg?:string }} [_ctx]
 * @returns {{ block:object|null, markdown:string } | null}
 */
export function renderAttendance(data, _ctx = {}) {
  if (!data || data.notFound || data.needsTimeWindow) return null;
  const days = Array.isArray(data.perDay) ? data.perDay : [];
  if (!days.length) return null;
  const total = Number(data.total ?? 0);

  if (days.length === 1) return renderSingleDay(days[0], total);
  return renderRange(days, total);
}

function renderSingleDay(day, total) {
  const c = day?.counts || {};
  const date = day?.date || '—';

  const chips = STATUS_ORDER.map((k) => ({
    label: k === 'WeekOff' ? 'Week off' : k,
    tone: STATUS_TONES[k] || 'neutral',
    count: Number(c[k] || 0),
  }));

  /** @type {object} */
  const summary = {
    type: 'kv',
    title: `Attendance · ${date}`,
    pairs: [
      { label: 'Total employees', value: String(total) },
      { label: 'Date',            value: date },
    ],
  };
  /** @type {object} */
  const badges = { type: 'badge_row', chips };
  /** @type {object} */
  const group = {
    type: 'group',
    title: `Attendance · ${date}`,
    collapsible: false,
    blocks: [summary, badges],
  };

  const markdown =
    `On **${date}**, attendance breakdown across **${total} employees**:\n\n` +
    STATUS_ORDER.map((k) => `- **${k === 'WeekOff' ? 'Week off' : k}:** ${c[k] || 0}`).join('\n');

  return { block: group, markdown };
}

function renderRange(days, total) {
  const rows = days.map((d) => {
    const c = d.counts || {};
    return {
      date: d.date,
      present:    Number(c.Present || 0),
      absent:     Number(c.Absent || 0),
      leave:      Number(c.Leave || 0),
      holiday:    Number(c.Holiday || 0),
      weekoff:    Number(c.WeekOff || 0),
      incomplete: Number(c.Incomplete || 0),
    };
  });

  /** @type {object} */
  const block = {
    type: 'table',
    id: 'attendance',
    title: `Attendance · ${days[0].date} → ${days[days.length - 1].date}`,
    columns: [
      { key: 'date',       label: 'Date',       priority: 'primary',   format: 'date' },
      { key: 'present',    label: 'Present',    priority: 'primary',   format: 'number', align: 'right' },
      { key: 'absent',     label: 'Absent',     priority: 'primary',   format: 'number', align: 'right' },
      { key: 'leave',      label: 'Leave',      priority: 'secondary', format: 'number', align: 'right' },
      { key: 'holiday',    label: 'Holiday',    priority: 'secondary', format: 'number', align: 'right' },
      { key: 'weekoff',    label: 'Week off',   priority: 'secondary', format: 'number', align: 'right' },
      { key: 'incomplete', label: 'Incomplete', priority: 'secondary', format: 'number', align: 'right' },
    ],
    rows,
    layout: 'auto',
  };

  const header = '| Date | Present | Absent | Leave | Holiday | Week off | Incomplete |';
  const sep    = '| --- | ---: | ---: | ---: | ---: | ---: | ---: |';
  const mdRows = rows.map(
    (r) => `| ${r.date} | ${r.present} | ${r.absent} | ${r.leave} | ${r.holiday} | ${r.weekoff} | ${r.incomplete} |`,
  );
  const footer = `\nTotal employees: ${total}.`;
  const markdown = [header, sep, ...mdRows, footer].join('\n');

  return { block, markdown };
}
