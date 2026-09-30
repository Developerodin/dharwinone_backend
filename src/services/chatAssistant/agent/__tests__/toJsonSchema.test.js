import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import { toJsonSchema } from '../toJsonSchema.js';

describe('toJsonSchema supported subset', () => {
  it('converts a plain string', () => {
    assert.deepEqual(toJsonSchema(Joi.string()), { type: 'string' });
  });

  it('converts .valid(...) to enum', () => {
    assert.deepEqual(toJsonSchema(Joi.string().valid('open', 'closed')), {
      type: 'string',
      enum: ['open', 'closed'],
    });
  });

  it('converts string .min/.max to minLength/maxLength', () => {
    assert.deepEqual(toJsonSchema(Joi.string().min(2).max(10)), {
      type: 'string',
      minLength: 2,
      maxLength: 10,
    });
  });

  it('converts a plain number', () => {
    assert.deepEqual(toJsonSchema(Joi.number()), { type: 'number' });
  });

  it('converts .integer() to type integer', () => {
    assert.deepEqual(toJsonSchema(Joi.number().integer()), { type: 'integer' });
  });

  it('converts number .min/.max to minimum/maximum', () => {
    assert.deepEqual(toJsonSchema(Joi.number().min(0).max(100)), {
      type: 'number',
      minimum: 0,
      maximum: 100,
    });
  });

  it('converts a boolean', () => {
    assert.deepEqual(toJsonSchema(Joi.boolean()), { type: 'boolean' });
  });

  it('converts an array of strings', () => {
    assert.deepEqual(toJsonSchema(Joi.array().items(Joi.string())), {
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('converts array .max() to maxItems', () => {
    assert.deepEqual(toJsonSchema(Joi.array().items(Joi.string()).max(5)), {
      type: 'array',
      items: { type: 'string' },
      maxItems: 5,
    });
  });

  it('converts array .min() to minItems and plain .unique() to uniqueItems', () => {
    assert.deepEqual(toJsonSchema(Joi.array().items(Joi.string()).min(1).max(5).unique()), {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
    });
  });

  it('converts a nested object with required keys and additionalProperties:false', () => {
    const schema = Joi.object({
      name: Joi.string().required(),
      address: Joi.object({
        city: Joi.string().required(),
        zip: Joi.string(),
      }),
    });
    assert.deepEqual(toJsonSchema(schema), {
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            zip: { type: 'string' },
          },
          required: ['city'],
          additionalProperties: false,
        },
      },
      required: ['name'],
      additionalProperties: false,
    });
  });

  it('omits required when no key is required', () => {
    const schema = Joi.object({ note: Joi.string() });
    const result = toJsonSchema(schema);
    assert.equal('required' in result, false);
  });

  it('carries .description() through', () => {
    assert.deepEqual(toJsonSchema(Joi.string().description('the job id')), {
      type: 'string',
      description: 'the job id',
    });
  });

  it('carries .default() through', () => {
    assert.deepEqual(toJsonSchema(Joi.string().default('open')), {
      type: 'string',
      default: 'open',
    });
  });

  it('converts alternatives(string, array-of-string) to anyOf', () => {
    const schema = Joi.alternatives().try(Joi.string(), Joi.array().items(Joi.string()));
    assert.deepEqual(toJsonSchema(schema), {
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    });
  });

  it('converts trivial allow(null) to a type array', () => {
    assert.deepEqual(toJsonSchema(Joi.string().allow(null)), {
      type: ['string', 'null'],
    });
  });

  it('converts allow(null) combined with an enum to a nullable enum', () => {
    assert.deepEqual(toJsonSchema(Joi.string().valid('a', 'b').allow(null)), {
      type: ['string', 'null'],
      enum: ['a', 'b', null],
    });
  });
});

describe('toJsonSchema unsupported features throw at load', () => {
  it('throws on date schemas', () => {
    assert.throws(() => toJsonSchema(Joi.date()), /Unsupported Joi feature 'date' at \(root\)/);
  });

  it('throws on custom rules', () => {
    assert.throws(
      () => toJsonSchema(Joi.string().custom((v) => v, 'custom rule')),
      /Unsupported Joi feature 'custom' at \(root\)/
    );
  });

  it('throws on when/conditional schemas', () => {
    const schema = Joi.object({
      a: Joi.string(),
      b: Joi.string().when('a', { is: 'x', then: Joi.required() }),
    });
    assert.throws(() => toJsonSchema(schema), /Unsupported Joi feature 'when\/conditional' at b/);
  });

  it('throws on refs', () => {
    const schema = Joi.object({ a: Joi.string(), b: Joi.ref('a') });
    assert.throws(() => toJsonSchema(schema), /Unsupported Joi feature '.+' at b/);
  });

  it('throws on array with multiple item schemas', () => {
    const schema = Joi.array().items(Joi.string(), Joi.number());
    assert.throws(
      () => toJsonSchema(schema),
      /Unsupported Joi feature 'array with multiple item schemas' at \(root\)/
    );
  });

  it('throws on .unique() with a key or function comparator (JSON Schema cannot state it)', () => {
    const byKey = Joi.array().items(Joi.object({ id: Joi.string() })).unique('id');
    const byFn = Joi.array().items(Joi.string()).unique((a, b) => a === b);
    assert.throws(() => toJsonSchema(byKey), /Unsupported Joi feature 'unique with a comparator or options' at \(root\)/);
    assert.throws(() => toJsonSchema(byFn), /Unsupported Joi feature 'unique with a comparator or options' at \(root\)/);
  });

  it('.trim() only normalises: the JSON Schema is unchanged', () => {
    assert.deepEqual(toJsonSchema(Joi.string().trim().max(24)), { type: 'string', maxLength: 24 });
  });

  it('converts a plain string .pattern() to pattern; flags or invert throw', () => {
    assert.deepEqual(toJsonSchema(Joi.string().pattern(/^[0-9a-fA-F]{24}$/)), { type: 'string', pattern: '^[0-9a-fA-F]{24}$' });
    assert.deepEqual(toJsonSchema(Joi.string().pattern(/^a\/b$/, 'slash')), { type: 'string', pattern: '^a\\/b$' });
    assert.throws(() => toJsonSchema(Joi.string().pattern(/^ab$/i)), /'pattern with flags or invert' at \(root\)/);
    assert.throws(() => toJsonSchema(Joi.string().pattern(/^ab$/, { invert: true })), /'pattern with flags or invert'/);
  });

  it('throws on .unique() with a key or function comparator (JSON Schema cannot state it)', () => {
    const byKey = Joi.array().items(Joi.object({ id: Joi.string() })).unique('id');
    const byFn = Joi.array().items(Joi.string()).unique((a, b) => a === b);
    assert.throws(() => toJsonSchema(byKey), /Unsupported Joi feature 'unique with a comparator or options' at \(root\)/);
    assert.throws(() => toJsonSchema(byFn), /Unsupported Joi feature 'unique with a comparator or options' at \(root\)/);
  });

  it('throws on object pattern keys', () => {
    const schema = Joi.object().pattern(Joi.string(), Joi.string());
    assert.throws(() => toJsonSchema(schema), /Unsupported Joi feature 'pattern keys' at \(root\)/);
  });

  it('throws on allow(null) combined with non-enum extra values', () => {
    const schema = Joi.string().allow('a', 'b', null);
    assert.throws(
      () => toJsonSchema(schema),
      /Unsupported Joi feature 'allow\(\.\.\.\) with non-enum values' at \(root\)/
    );
  });

  it('throws on allow(null) on a non-scalar schema', () => {
    const schema = Joi.array().items(Joi.string()).allow(null);
    assert.throws(
      () => toJsonSchema(schema),
      /Unsupported Joi feature 'allow\(null\)' at \(root\)/
    );
  });

  it('includes the nested path in the error message', () => {
    const schema = Joi.object({
      job: Joi.object({
        postedAt: Joi.date(),
      }),
    });
    assert.throws(() => toJsonSchema(schema), /at job\.postedAt/);
  });

  it('includes the array item path in the error message', () => {
    const schema = Joi.array().items(Joi.date());
    assert.throws(() => toJsonSchema(schema), /at \[\]/);
  });
});
