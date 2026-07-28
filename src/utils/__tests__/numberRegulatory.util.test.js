import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressRequiresVerification,
  computeRequiresVerification,
  hasSubstantiveRequirements,
  regulationRequiresVerification,
} from '../numberRegulatory.util.js';

test('addressRequiresVerification: none is purchasable', () => {
  assert.equal(addressRequiresVerification('none'), false);
  assert.equal(addressRequiresVerification('NONE'), false);
});

test('addressRequiresVerification: any/local/foreign need verification', () => {
  assert.equal(addressRequiresVerification('local'), true);
  assert.equal(addressRequiresVerification('any'), true);
  assert.equal(addressRequiresVerification('foreign'), true);
});

test('regulationRequiresVerification: empty list is purchasable', () => {
  assert.equal(regulationRequiresVerification([]), false);
});

test('regulationRequiresVerification: supporting documents block purchase', () => {
  const regs = [
    {
      requirements: {
        supporting_document: [['commercial_registrar_excerpt']],
      },
    },
  ];
  assert.equal(regulationRequiresVerification(regs), true);
});

test('computeRequiresVerification combines address + regulations', () => {
  assert.equal(
    computeRequiresVerification({ addressRequirements: 'none', regulations: [] }),
    false,
  );
  assert.equal(
    computeRequiresVerification({
      addressRequirements: 'none',
      regulations: [{ requirements: { end_user: ['name'] } }],
    }),
    true,
  );
  assert.equal(
    computeRequiresVerification({ addressRequirements: 'local', regulations: [] }),
    true,
  );
});

test('hasSubstantiveRequirements ignores empty objects', () => {
  assert.equal(hasSubstantiveRequirements({}), false);
  assert.equal(hasSubstantiveRequirements(null), false);
});
