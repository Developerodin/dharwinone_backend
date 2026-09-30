import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { checkAccessRule } from '../../../toolAccess.js';
import { ORG_READ_PERMISSIONS } from '../../../orgStructureAnalytics.js';
import { PEOPLE_PROFILE_ACCESS } from '../people/common.js';
import { PLACEMENTS_ACCESS } from '../hiring/common.js';
import { TRAINING_ACCESS } from '../training/common.js';
import { ADVICE_ACCESS, adviceDeps, adviceScope, rule, sectionStatus } from './common.js';
import {
  capacityFromBuckets, capacityFromCanAssign, conclude, employeeListRules, gateBypassRule, joinedRule, leaveRule,
  orgChartRules, placementFacts, preboardingGateRule, profileFacts, promotionRule, resignedRule, sectionEvidence,
  transitionRule,
} from './explainRules.js';

export const QUESTIONS = Object.freeze([
  'why_unavailable', 'cannot_join_project', 'cannot_move_to_onboarding',
  'not_in_employee_list', 'not_in_org_tree', 'cannot_see_record',
]);

const SECTION_TIMEOUT_MS = 8000;
const call = (name, args) => ({ name, args, timeoutMs: SECTION_TIMEOUT_MS });
const placementCall = (name) => call('get_placement', { candidate: name });
const statuses = (outs) => Object.fromEntries(Object.entries(outs).map(([k, v]) => [k, sectionStatus(v).status]));

/** "Why can't I see X": per module, did the permission let the viewer in, and was this person inside its row scope. */
const SEE_MODULES = Object.freeze([
  { key: 'placement', label: 'their placement', access: PLACEMENTS_ACCESS, call: placementCall },
  { key: 'training', label: 'their training', access: TRAINING_ACCESS, call: (n) => call('get_training_progress', { mode: 'person', person: n }) },
  { key: 'tasks', label: 'their tasks', access: null, call: (n) => call('list_tasks', { filters: { assigneeName: n }, limit: 1 }) },
  { key: 'orgChart', label: 'their org-chart position', access: { anyOf: ORG_READ_PERMISSIONS }, call: (n) => call('get_reporting_chain', { mode: 'chain', person: n }) },
]);

/** A module's row-scope verdict from its own result: true inside, false refused, null unknown. */
function scopeVerdict(key, out, pf) {
  const r = out?.result;
  if (key === 'placement') {
    const pl = placementFacts(out, pf);
    if (pl.noAccess) return { met: false, evidence: 'This placement is outside your placement scope.' };
    if (pl.found) return { met: true };
    return { met: null, evidence: pl.matches ? 'Several placements match this name.' : 'No placement you can see for this person.' };
  }
  if (key === 'training') {
    if (/students\.read/.test(r?.error || '')) return { met: false, evidence: 'Other people\'s training needs students.read.' };
    if (r?.matches) return { met: null, evidence: 'Several people match this name.' };
    if (r?.noStudentProfile) return { met: true, evidence: 'Visible, but they have no training profile.' };
    return r?.error ? { met: null, evidence: 'The training check failed.' } : { met: true };
  }
  if (key === 'tasks') {
    if (/only see your own tasks/.test(r?.error || '')) return { met: false, evidence: 'Other people\'s tasks need tasks.read.' };
    if (r?.notFound || r?.ambiguous) return { met: null, evidence: r.notFound ? 'No assignee by that name.' : 'Several assignees match this name.' };
    return r?.error ? { met: null, evidence: 'The tasks check failed.' } : { met: true };
  }
  if (r?.ambiguous) return { met: null, evidence: 'Several people on the chart match this name.' };
  if (r?.notFound) return { met: null, evidence: 'Not on the org chart you can see.' };
  return { met: true };
}

function seeRules(pf, userOut, outs) {
  const rules = [];
  const profileSection = sectionStatus(userOut);
  if (profileSection.status === 'restricted') {
    rules.push(rule('You can open their profile', 'get_user access', false, `Needs one of: ${PEOPLE_PROFILE_ACCESS.anyOf.join(', ')}.`));
  } else if (profileSection.status !== 'ok') {
    rules.push(rule('You can open their profile', 'get_user access', null, sectionEvidence(profileSection, 'profile')));
  } else {
    rules.push(rule('Their profile is inside your scope', 'people/getUser.tool.js row scope (resolveRowScope)',
      !(pf.outOfScope || pf.notPermitted),
      pf.outOfScope ? 'Their Employee/Candidate profile is outside your scope.' : pf.notPermitted ? 'Your role cannot read profile sections.' : null));
  }
  for (const m of SEE_MODULES) {
    const out = outs[m.key];
    const s = sectionStatus(out);
    if (s.status === 'restricted') {
      rules.push(rule(`You can open ${m.label}`, `${m.call('').name} access`, false,
        m.access?.anyOf ? `Needs one of: ${m.access.anyOf.join(', ')}.` : 'Refused by the module.'));
      continue;
    }
    if (s.status === 'timeout' || (s.status === 'error' && out?.status !== 'ok')) {
      rules.push(rule(`You can open ${m.label}`, `${m.call('').name} access`, null, sectionEvidence(s, m.label)));
      continue;
    }
    const v = scopeVerdict(m.key, out, pf);
    rules.push(rule(`${m.label[0].toUpperCase()}${m.label.slice(1)} is inside your scope`, `${m.call('').name} row scope`, v.met, v.evidence ?? null));
  }
  return rules;
}

const PLANS = {
  why_unavailable: {
    calls: (name) => ({
      leave: call('who_is_on_leave_today', {}),
      atTwo: call('get_allocation', { mode: 'list', bucket: 'projects_2', limit: 50 }),
      atThreePlus: call('get_allocation', { mode: 'list', bucket: 'projects_3_plus', limit: 50 }),
      placement: placementCall(name),
    }),
    evaluate: ({ pf, outs }) => {
      const pl = placementFacts(outs.placement, pf);
      return {
        rules: [
          resignedRule(pf),
          leaveRule(outs.leave, pf),
          capacityFromBuckets([outs.atTwo, outs.atThreePlus], pf),
          // Only a placement you can see says anything about joining; a long-standing employee has none.
          ...(pl.found ? [joinedRule(pl)] : []),
        ],
      };
    },
  },
  cannot_join_project: {
    calls: (name, { project }) => ({
      canAssign: call('get_allocation', { mode: 'can_assign', person: name, project }),
      leave: call('who_is_on_leave_today', {}),
    }),
    evaluate: ({ pf, outs }) => {
      const cap = capacityFromCanAssign(outs.canAssign);
      if (cap.matches) return { matches: cap.matches };
      return {
        rules: [cap.rule],
        // DharwinOne does not block an assignment for either of these — shown so the answer can mention them.
        context: [resignedRule(pf), leaveRule(outs.leave, pf)],
      };
    },
  },
  cannot_move_to_onboarding: {
    calls: (name) => ({ placement: placementCall(name) }),
    evaluate: async ({ pf, outs, user }) => {
      const pl = placementFacts(outs.placement, pf);
      if (pl.matches) return { matches: { ambiguous: 'placement', matches: pl.matches } };
      const canBypass = (await checkAccessRule({ anyOf: ['preboarding.override', 'candidates.manage'] }, user)).ok;
      return { rules: [transitionRule(pl), preboardingGateRule(pl), gateBypassRule(canBypass)] };
    },
  },
  not_in_employee_list: {
    calls: (name, _args, pf) => (pf.section.status === 'ok' && pf.hasEmployeeRole ? {} : { placement: placementCall(name) }),
    evaluate: ({ pf, outs }) => {
      const rules = employeeListRules(pf);
      if (outs.placement) rules.push(promotionRule(placementFacts(outs.placement, pf)));
      return {
        rules,
        notApplied: ['hideFromDirectory — the Employees list does not filter on it (only the Users directory does).'],
      };
    },
  },
  not_in_org_tree: {
    calls: (name) => ({ chart: call('get_reporting_chain', { mode: 'chain', person: name }) }),
    evaluate: ({ pf, outs }) => {
      const chart = orgChartRules(outs.chart);
      if (chart.matches) return { matches: chart.matches };
      const [search, dept] = chart.rules;
      const ok = pf.section.status === 'ok';
      return {
        rules: [
          search,
          rule('Their login holds the Employee role', 'orgStructure.service.js employeeScopeFilter', ok ? pf.hasEmployeeRole : null,
            ok ? null : sectionEvidence(pf.section, 'this person\'s profile')),
          resignedRule(pf),
          dept,
        ],
      };
    },
  },
  cannot_see_record: {
    calls: (name) => Object.fromEntries(SEE_MODULES.map((m) => [m.key, m.call(name)])),
    evaluate: ({ pf, outs, userOut }) => ({ rules: seeRules(pf, userOut, outs) }),
  },
};

export default defineTool({
  name: 'explain_status',
  domain: 'advice',
  kind: 'read',
  description:
    'Explains WHY a person is in a state, as the rules DharwinOne enforces with evidence for each: why someone ' +
    'is unavailable (resigned / on leave today / at the 2-active-project limit / not joined), why they cannot join ' +
    'a project, cannot move to Onboarding (pre-boarding gate), are not on the Employees page, not on the org chart, ' +
    'or why you cannot see their record. Use for "why can\'t X…", "why isn\'t X…", "why is X blocked". Not for ' +
    'listing people (use the list tools) or for what X is doing now (get_person_360 / get_user).',
  measure:
    'Each rule is a condition the named code enforces, checked against this person through the module tools ' +
    'under your access; met is true, false, or null when a section was restricted, failed, or not captured.',
  input: Joi.object({
    person: Joi.string().trim().min(1).max(120).required().description('Person name or email.'),
    question: Joi.string().valid(...QUESTIONS).required()
      .description('why_unavailable · cannot_join_project (needs project) · cannot_move_to_onboarding · ' +
        'not_in_employee_list · not_in_org_tree · cannot_see_record (your own access to their records).'),
    project: Joi.string().trim().min(1).max(160).description('Project name — cannot_join_project only.'),
  }),
  access: ADVICE_ACCESS,
  timeoutMs: 12000,
  async execute({ person, question, project }, ctx) {
    const user = adviceScope(ctx);
    const { run, runAll } = adviceDeps(ctx);
    if (question === 'cannot_join_project' && !project) return { question, error: 'cannot_join_project needs project.' };

    const userOut = await run('get_user', { name: person }, { timeoutMs: SECTION_TIMEOUT_MS });
    const pf = profileFacts(userOut);
    if (pf.matches?.length > 1) return { question, person, matches: pf.matches.slice(0, 10) };
    if (pf.matches) return { question, notFound: 'person', searchedFor: person };
    const name = pf.name ?? person;

    const plan = PLANS[question];
    const planned = plan.calls(name, { project }, pf);
    const keys = Object.keys(planned);
    const results = await runAll(keys.map((k) => planned[k]));
    const outs = Object.fromEntries(keys.map((k, i) => [k, results[i]]));

    const out = await plan.evaluate({ pf, outs, name, user, userOut });
    if (out.matches) return { question, person: name, ...out.matches };
    return {
      question,
      person: name,
      ...(project ? { project } : {}),
      rules: out.rules,
      ...(out.context ? { context: out.context } : {}),
      ...(out.notApplied ? { notApplied: out.notApplied } : {}),
      conclusion: conclude(question, out.rules),
      sections: { profile: pf.section.status, ...statuses(outs) },
    };
  },
  render(result) {
    if (!result?.rules?.length) return null;
    const met = (m) => (m === true ? 'yes' : m === false ? 'no' : 'unknown');
    return {
      blocks: [{
        type: 'table',
        id: 'explain-status',
        tableType: 'explain-status',
        title: `Why — ${result.person}`,
        columns: [
          { key: 'rule', label: 'Rule', priority: 'primary' },
          { key: 'met', label: 'Met', priority: 'primary' },
        ],
        rows: [...result.rules, ...(result.context || [])].map((r) => ({ rule: r.rule, met: met(r.met) })),
        layout: 'auto',
      }],
      facts: { counts: [{ kind: 'explain_status', label: 'rules not met', total: result.rules.filter((r) => r.met === false).length }] },
    };
  },
});
