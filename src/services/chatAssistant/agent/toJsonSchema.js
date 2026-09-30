/**
 * Joi -> JSON Schema converter for Sage tool input schemas (agent/defineTool.js).
 *
 * Supports only the subset agent tool inputs use: object (nested, required),
 * string/number/integer/boolean, array (single item schema; `.min`/`.max`/plain
 * `.unique()` as minItems/maxItems/uniqueItems), `.valid(...)` as
 * enum, `alternatives().try(...)` as anyOf (the "string OR array of strings"
 * search-filter shape), string `.pattern()` without flags, `.description()`, `.default()`, and a narrow
 * `.allow(null)` case for plain-or-enum scalars. Anything outside this subset
 * throws `Unsupported Joi feature '<x>' at <path>` so a bad tool fails when
 * `defineTool` loads it, not mid-chat when the model calls it.
 */

// `trim` only normalises the value before validation; there is nothing for the model to see.
const STRING_RULES = ['min', 'max', 'pattern', 'trim'];
const NUMBER_RULES = ['integer', 'min', 'max'];
const ARRAY_RULES = ['min', 'max', 'unique'];
const NULLABLE_TYPES = ['string', 'number', 'integer', 'boolean'];

function pathLabel(path) {
  return path || '(root)';
}

function unsupported(feature, path) {
  return new Error(`Unsupported Joi feature '${feature}' at ${pathLabel(path)}`);
}

function applyDescriptionAndDefault(desc, schema) {
  const flags = desc.flags || {};
  if (flags.description !== undefined) schema.description = flags.description;
  if ('default' in flags) schema.default = flags.default;
}

// `.allow(null)` is only converted for the trivial cases we actually use:
// a plain nullable scalar, or an enum with null added. Anything else (allow()
// with unrelated extra values, or allow(null) on an object/array/alternatives)
// throws rather than guess at intent.
function applyNullable(desc, schema, path) {
  const allow = desc.allow;
  if (!Array.isArray(allow) || !allow.includes(null)) return;

  const nonNull = allow.filter((v) => v !== null);
  const isEnum = !!(desc.flags && desc.flags.only);
  if (!isEnum && nonNull.length > 0) {
    throw unsupported('allow(...) with non-enum values', path);
  }
  if (!NULLABLE_TYPES.includes(schema.type)) {
    throw unsupported('allow(null)', path);
  }
  schema.type = [schema.type, 'null'];
  if (schema.enum) schema.enum = [...schema.enum, null];
}

function convertString(desc, path) {
  const schema = { type: 'string' };
  if (desc.flags && desc.flags.only) {
    schema.enum = (desc.allow || []).filter((v) => v !== null);
  }
  for (const rule of desc.rules || []) {
    if (!STRING_RULES.includes(rule.name)) throw unsupported(rule.name, path);
    if (rule.name === 'min') schema.minLength = rule.args.limit;
    if (rule.name === 'max') schema.maxLength = rule.args.limit;
    if (rule.name === 'pattern') schema.pattern = convertPattern(rule.args, path);
  }
  return schema;
}

// describe() gives the regex as '/source/flags'. JSON Schema `pattern` has no flags and no
// invert, so only a plain regex converts.
function convertPattern({ regex, options }, path) {
  const match = /^\/(.*)\/([a-z]*)$/s.exec(regex);
  if (!match || match[2] || options?.invert) throw unsupported('pattern with flags or invert', path);
  return match[1];
}

function convertNumber(desc, path) {
  const schema = { type: 'number' };
  for (const rule of desc.rules || []) {
    if (!NUMBER_RULES.includes(rule.name)) throw unsupported(rule.name, path);
    if (rule.name === 'integer') schema.type = 'integer';
    if (rule.name === 'min') schema.minimum = rule.args.limit;
    if (rule.name === 'max') schema.maximum = rule.args.limit;
  }
  return schema;
}

function convertBoolean() {
  return { type: 'boolean' };
}

function convertArray(desc, path) {
  const schema = { type: 'array' };
  if (desc.items) {
    if (desc.items.length !== 1) throw unsupported('array with multiple item schemas', path);
    schema.items = convertSchema(desc.items[0], `${path}[]`);
  }
  for (const rule of desc.rules || []) {
    if (!ARRAY_RULES.includes(rule.name)) throw unsupported(rule.name, path);
    if (rule.name === 'min') schema.minItems = rule.args.limit;
    if (rule.name === 'max') schema.maxItems = rule.args.limit;
    if (rule.name === 'unique') {
      // Only plain `.unique()` (whole-item equality) is `uniqueItems`; a key or function comparator
      // (describe() shows it as `args`) is a rule JSON Schema cannot state.
      if (rule.args) throw unsupported('unique with a comparator or options', path);
      schema.uniqueItems = true;
    }
  }
  return schema;
}

function convertObject(desc, path) {
  if (desc.patterns) throw unsupported('pattern keys', path);
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  const required = [];
  const keys = desc.keys || {};
  for (const [key, childDesc] of Object.entries(keys)) {
    const childPath = path ? `${path}.${key}` : key;
    schema.properties[key] = convertSchema(childDesc, childPath);
    if (childDesc.flags && childDesc.flags.presence === 'required') required.push(key);
  }
  if (required.length) schema.required = required;
  return schema;
}

function convertAlternatives(desc, path) {
  const matches = desc.matches || [];
  const anyOf = matches.map((match, index) => {
    if (!match.schema) throw unsupported('conditional alternatives (when)', path);
    return convertSchema(match.schema, `${path}|${index}`);
  });
  return { anyOf };
}

function convertSchema(desc, path) {
  if (desc.whens) throw unsupported('when/conditional', path);

  let schema;
  switch (desc.type) {
    case 'object':
      schema = convertObject(desc, path);
      break;
    case 'string':
      schema = convertString(desc, path);
      break;
    case 'number':
      schema = convertNumber(desc, path);
      break;
    case 'boolean':
      schema = convertBoolean();
      break;
    case 'array':
      schema = convertArray(desc, path);
      break;
    case 'alternatives':
      schema = convertAlternatives(desc, path);
      break;
    default:
      throw unsupported(desc.type, path);
  }

  applyDescriptionAndDefault(desc, schema);
  applyNullable(desc, schema, path);
  return schema;
}

/** @param {import('joi').Schema} joiSchema */
export function toJsonSchema(joiSchema) {
  if (!joiSchema || typeof joiSchema.describe !== 'function') {
    throw new Error('toJsonSchema requires a Joi schema');
  }
  return convertSchema(joiSchema.describe(), '');
}
