import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderDeterministicAnswer } from '../factRenderer.js';

describe('renderDeterministicAnswer employment breakdown', () => {
  it('labels working vs resigned and discloses hidden disabled accounts', () => {
    const out = renderDeterministicAnswer('how many employees', {
      primary: {
        kind: 'fetch_employees',
        label: 'employees',
        total: 35,
        breakdown: {
          active: 1,
          resigned: 34,
          total: 35,
          hiddenDisabledActive: 0,
          hiddenDisabledResigned: 1,
          hiddenDisabledTotal: 1,
        },
      },
      counts: [],
    });
    assert.match(out, /working:\s*\*\*1\*\*/i);
    assert.match(out, /resigned:\s*\*\*34\*\*/i);
    assert.match(out, /disabled/i);
    assert.match(out, /not counted/i);
  });

  it('omits the disabled sentence when none were excluded', () => {
    const out = renderDeterministicAnswer('how many employees', {
      primary: {
        kind: 'fetch_employees',
        label: 'employees',
        total: 35,
        breakdown: { active: 1, resigned: 34, total: 35, hiddenDisabledTotal: 0 },
      },
      counts: [],
    });
    assert.match(out, /working:/i);
    assert.doesNotMatch(out, /disabled/i);
  });
});
