import { renderDeterministicEmployeeList } from '../renderers/employees.js';
import { describeFilterGroup, groupTableTitle } from './filterGroups.js';

function employeeNoun(total) {
  return total === 1 ? 'employee' : 'employees';
}

function renderGroupCountPhrase(group) {
  const total = Number(group.count ?? 0);
  const desc = describeFilterGroup(group.filters).toLowerCase();
  const verb = total === 1 ? 'is' : 'are';
  return `**${total}** ${desc} ${employeeNoun(total)}`;
}

/**
 * @param {{ plan: object, groups: object[], total: number }} compoundResult
 * @param {{ viewerRole?: string }} [ctx]
 */
export function renderCompoundEmployeeQueryResult(compoundResult, ctx = {}) {
  const { plan, groups } = compoundResult;
  const wantsList = plan.intent === 'list';
  const proseParts = [];
  const blocks = [];

  if (!wantsList) {
    if (groups.length === 1) {
      const g = groups[0];
      const total = Number(g.count ?? 0);
      const desc = describeFilterGroup(g.filters).toLowerCase();
      const verb = total === 1 ? 'is' : 'are';
      proseParts.push(`There ${verb} **${total}** ${desc} ${employeeNoun(total)}.`);
    } else {
      const parts = groups.map((g) => {
        const total = Number(g.count ?? 0);
        const label = describeFilterGroup(g.filters).toLowerCase();
        if (g.filters.employmentStatus === 'resigned') {
          return `**${total}** ${label} ${employeeNoun(total)} who have resigned`;
        }
        if (g.filters.employmentStatus === 'current') {
          return `**${total}** ${label} ${employeeNoun(total)} who are working`;
        }
        return renderGroupCountPhrase(g);
      });
      proseParts.push(`There are ${parts.join(' and ')}.`);
    }
  }

  if (wantsList) {
    for (const group of groups) {
      const toolResult = group.toolResult;
      if (!toolResult?.records?.length) continue;

      const listOut = renderDeterministicEmployeeList(toolResult, ctx);
      const groupBlocks = listOut?.blocks?.length
        ? listOut.blocks
        : listOut?.block
          ? [listOut.block]
          : [];

      for (const block of groupBlocks) {
        block.title = groupTableTitle(group.filters, group.count ?? toolResult.total);
        blocks.push(block);
      }

      if (!groupBlocks.length) continue;
      const label = describeFilterGroup(group.filters);
      proseParts.push(
        `Here ${Number(group.count) === 1 ? 'is' : 'are'} **${group.count}** ${label.toLowerCase()} ${employeeNoun(group.count)} — see the table below.`
      );
    }

    if (!proseParts.length && blocks.length) {
      proseParts.push('See the tables below for details.');
    }
  }

  return {
    reply: proseParts.join('\n\n'),
    blocks,
    deterministic: true,
  };
}
