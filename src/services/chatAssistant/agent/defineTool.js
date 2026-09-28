import { toJsonSchema } from './toJsonSchema.js';

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
const KINDS = ['read', 'write'];

function fail(name, message) {
  const label = name || '(unnamed tool)';
  throw new Error(`defineTool(${label}): ${message}`);
}

function isJoiObjectSchema(schema) {
  return !!schema && typeof schema.describe === 'function' && schema.describe().type === 'object';
}

// Mirrors src/services/chatAssistant/toolAccess.js TOOL_ACCESS entry semantics:
// `anyOf` (non-empty permission list) or `note` (handler already enforces access).
function isValidAccess(access) {
  if (!access || typeof access !== 'object') return false;
  const hasAnyOf =
    Array.isArray(access.anyOf) &&
    access.anyOf.length > 0 &&
    access.anyOf.every((p) => typeof p === 'string' && p.length > 0);
  const hasNote = typeof access.note === 'string' && access.note.trim().length > 0;
  return hasAnyOf || hasNote;
}

/**
 * Defines one agent tool (`agent/tools/<domain>/<name>.tool.js`). Validates the
 * definition and computes its JSON Schema up front so a bad tool throws at
 * load time, never mid-chat. See architecture.md §1.
 */
export function defineTool(def) {
  const { name, domain, kind, description, input, access, execute, render } = def || {};

  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    fail(name, `name must match ${NAME_RE} (got ${JSON.stringify(name)})`);
  }
  if (typeof domain !== 'string' || domain.length === 0) {
    fail(name, 'domain is required (non-empty string)');
  }
  if (!KINDS.includes(kind)) {
    fail(name, `kind must be 'read' or 'write' (got ${JSON.stringify(kind)})`);
  }
  if (typeof description !== 'string' || description.length === 0) {
    fail(name, 'description is required (non-empty string)');
  }
  if (!isJoiObjectSchema(input)) {
    fail(name, 'input must be a Joi object schema');
  }
  if (!isValidAccess(access)) {
    fail(name, "access must be { anyOf: [...] } (non-empty) or { note: '...' } (see toolAccess.js)");
  }
  if (typeof execute !== 'function') {
    fail(name, 'execute must be a function');
  }
  if (render !== undefined && typeof render !== 'function') {
    fail(name, 'render must be a function when present');
  }

  let jsonSchema;
  try {
    jsonSchema = toJsonSchema(input);
  } catch (err) {
    fail(name, `input schema conversion failed: ${err.message}`);
  }

  return Object.freeze({ name, domain, kind, description, input, access, execute, render, jsonSchema });
}

/**
 * Throws on a duplicate tool name. `defineTool` only sees one definition at a
 * time, so the registry (Task 4) calls this once over the full tool list.
 */
export function assertUniqueToolNames(tools) {
  const seen = new Set();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool name: '${tool.name}'`);
    }
    seen.add(tool.name);
  }
}
