import { COMPENSATION_LABELS } from './employeeFilter.registry.js';
import { renderDeterministicEmployeeList } from '../../services/chatAssistant/renderers/employees.js';

function filterDescriptor(filters = {}) {
  const parts = [];
  if (filters.compensationType && COMPENSATION_LABELS[filters.compensationType]) {
    parts.push(COMPENSATION_LABELS[filters.compensationType]);
  }
  // "active" belongs to the account axis (Active/Disabled/Pending). Employment
  // is Current/Resigned; borrowing the other axis's word is what turned a
  // compensation answer into an apparent claim about sign-in status.
  if (filters.employmentStatus === 'resigned') {
    parts.push('resigned');
  } else if (filters.employmentStatus === 'current') {
    parts.push('current');
  }
  return parts.join(' ').trim();
}

function employeeNoun(total) {
  return total === 1 ? 'employee' : 'employees';
}

function breakdownFromToolResult(toolResult) {
  if (toolResult.employmentBreakdown) {
    return toolResult.employmentBreakdown;
  }
  const records = Array.isArray(toolResult.records) ? toolResult.records : [];
  // A count-only result carries no records; never let an empty array become "0 employees".
  if (records.length === 0 && Number(toolResult.total ?? 0) > 0) {
    return { active: null, resigned: null, total: Number(toolResult.total) };
  }
  const active = records.filter((r) => {
    const state = r.employmentState || (r.resignDate ? 'resigned' : 'active');
    return String(state).toLowerCase() !== 'resigned';
  }).length;
  const resigned = records.length - active;
  return { active, resigned, total: records.length };
}

function renderAllStatusCountProse(toolResult) {
  const filters = toolResult.query?.filters || {};
  const { active, resigned, total } = breakdownFromToolResult(toolResult);
  const desc = filterDescriptor({ ...filters, employmentStatus: undefined });
  const label = desc ? `${desc} ${employeeNoun(total)}` : employeeNoun(total);

  if (active === null || resigned === null) {
    return `There ${total === 1 ? 'is' : 'are'} **${total}** ${label} in total.`;
  }

  const resignedPhrase = resigned === 1 ? '1 has resigned' : `${resigned} have resigned`;
  // "currently working" matches the per-row status label the table already uses.
  const activePhrase = active === 1 ? '1 is currently working' : `${active} are currently working`;

  return (
    `There ${total === 1 ? 'is' : 'are'} **${total}** ${label} in total — ` +
    `${activePhrase} and ${resignedPhrase}.`
  );
}

function renderCountProse(toolResult) {
  const filters = toolResult.query?.filters || {};
  if (filters.employmentStatus === 'all') {
    return renderAllStatusCountProse(toolResult);
  }

  const total = Number(toolResult.total ?? 0);
  const desc = filterDescriptor(filters);
  const verb = total === 1 ? 'is' : 'are';
  const noun = employeeNoun(total);

  if (desc) {
    return `There ${verb} **${total}** ${desc} ${noun}.`;
  }
  return `There ${verb} **${total}** ${noun}.`;
}

function renderEmptyListProse(toolResult) {
  const filters = toolResult.query?.filters || {};
  if (filters.compensationType === 'unpaid') {
    return 'No unpaid employees found.';
  }
  const desc = filterDescriptor(filters);
  if (desc) {
    return `No ${desc.toLowerCase()} employees found.`;
  }
  return 'No employees found.';
}

function renderListIntro(toolResult) {
  const filters = toolResult.query?.filters || {};
  const total = Number(toolResult.total ?? toolResult.records?.length ?? 0);
  const desc = filterDescriptor(filters);
  const noun = employeeNoun(total);

  // Truncation is load-bearing — state it before any status framing.
  if (toolResult.truncated) {
    return (
      `Showing **${toolResult.returned ?? toolResult.records?.length ?? 0}** of **${total}** ` +
      `${desc ? `${desc.toLowerCase()} ` : ''}${noun} (list capped). See the table below.`
    );
  }

  if (filters.employmentStatus === 'all') {
    return renderAllStatusCountProse(toolResult);
  }

  if (desc) {
    return `Here ${total === 1 ? 'is' : 'are'} **${total}** ${desc} ${noun} — see the table below.`;
  }
  return `Here ${total === 1 ? 'is' : 'are'} **${total}** ${noun} — see the table below.`;
}

/**
 * Deterministic count/list renderer for employee entityQuery ToolResultContract.
 *
 * @param {object} toolResult - executeEmployeeQuery success/failure payload
 * @param {{ viewerRole?: string }} [ctx]
 * @returns {{ reply: string, blocks: object[], deterministic: true }}
 */
export function renderEmployeeQueryResult(toolResult, ctx = {}) {
  if (!toolResult?.success) {
    return {
      reply: toolResult?.message || 'Unable to retrieve employee data.',
      blocks: [],
      deterministic: true,
    };
  }

  const operations = toolResult.query?.operations || [];
  const wantsCount = operations.includes('count');
  const wantsList = operations.includes('list');
  const records = Array.isArray(toolResult.records) ? toolResult.records : [];
  const statusIsAll = toolResult.query?.filters?.employmentStatus === 'all';

  const proseParts = [];
  const blocks = [];

  if (wantsCount) {
    proseParts.push(renderCountProse(toolResult));
  }

  if (wantsList) {
    if (records.length === 0) {
      const knownTotal = Number(toolResult.total ?? 0);
      if (knownTotal > 0) {
        // An out-of-range page is not an empty result set.
        const pageNum = toolResult.page ?? 1;
        proseParts.push(
          `Page ${pageNum} is empty — there are **${knownTotal}** matching ` +
            `${employeeNoun(knownTotal)} in total. Ask again without a page number.`
        );
      } else if (!wantsCount) {
        proseParts.push(renderEmptyListProse(toolResult));
      }
    } else {
      const listOut = renderDeterministicEmployeeList(toolResult, ctx);
      if (listOut?.blocks?.length) {
        blocks.push(...listOut.blocks);
      } else if (listOut?.block) {
        blocks.push(listOut.block);
      }
      if (wantsCount) {
        if (!statusIsAll) {
          proseParts.push('See the table below for details.');
        }
      } else {
        proseParts.push(renderListIntro(toolResult));
      }
      // A page of a larger result set must say so. `truncated` covers the getAll
      // cap and renders its own notice; this covers ordinary pagination.
      const listTotal = Number(toolResult.total ?? records.length);
      if (!toolResult.truncated && listTotal > records.length) {
        proseParts.push(
          `Showing **${records.length}** of **${listTotal}** — narrow the filter ` +
            'to see the rest.'
        );
      }
      if (listOut?.sectionMarkdown) {
        proseParts.push(listOut.sectionMarkdown);
      }
    }
  }

  if (!proseParts.length && blocks.length) {
    proseParts.push(renderListIntro(toolResult));
  }

  return {
    reply: proseParts.join('\n\n'),
    blocks,
    deterministic: true,
  };
}
