/**
 * CI assertion: every permission-matrix row maps to >= 1 enforcing route guard.
 *
 * WHY: The role editor matrix (frontend PERMISSION_SECTIONS) renders a checkbox per
 * feature. A checkbox is meaningful only if some backend guard actually requires the
 * permission that checkbox derives. Rows that derive a key no guard checks are "dead"
 * (cosmetic) or, worse, "wrong-key" (admin grants the box, backend silently gates on a
 * different permission). This script catches both, and catches drift in either direction.
 *
 * HOW (faithful to runtime â€” no re-implementation of the rules):
 *   1. Parse PERMISSION_SECTIONS from the frontend repo (the matrix source of truth).
 *   2. For each row, simulate a role holding ONLY that row (all 4 actions) and run it
 *      through the REAL backend deriveApiPermissions() -> the API permission set the row
 *      grants.
 *   3. Scan backend src/ for every permission key referenced by a guard
 *      (requirePermissions / requireAnyOfPermissions / requirePermissionOrAdministrator /
 *      requireAdministratorOrPermission / getGrantingPermissions / hasApiPermission* / .has()).
 *   4. A row is ENFORCED if, for some guarded key K, the REAL getGrantingPermissions(K)
 *      intersects the row's granted set â€” exactly the check hasApiPermissionFromContext does.
 *
 * Ratchet: rows known-dead today live in INTENTIONALLY_UNENFORCED with a reason. The build
 * stays green now, but (a) a NEW dead row fails CI, and (b) wiring/removing an allowlisted
 * row makes its allowlist entry stale and fails CI until the entry is deleted. The allowlist
 * IS the worklist.
 *
 * Run:   node scripts/assert-permission-matrix-enforced.mjs
 * Env:   FRONTEND_DIR=/path/to/uat.dharwin.frontend   (default: ../uat.dharwin.frontend)
 *        STRICT=1   -> fail (exit 1) if the frontend matrix file is missing
 *                     (default: SKIP with a loud warning, exit 0, so unrelated CI isn't blocked)
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { deriveApiPermissions } from '../src/services/permission.service.js';
import { getGrantingPermissions } from '../src/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(BACKEND_ROOT, 'src');

const FRONTEND_DIR =
  process.env.FRONTEND_DIR || path.resolve(BACKEND_ROOT, '..', 'uat.dharwin.frontend');
const MATRIX_FILE = path.join(FRONTEND_DIR, 'shared', 'lib', 'roles-permissions.ts');

/**
 * Rows that legitimately have no backend guard, each with a reason.
 * Key format: "<sectionId>.<featureId>" (matches the saved permission prefix).
 * BUG: ... entries are tracked defects (wrong-key gating), not "fine" â€” fix or remove the row.
 */
const INTENTIONALLY_UNENFORCED = {
  'general.dashboard': 'Nav-only row; no backend resource (sidebar visibility only).',
  'settings.personal-information': 'Self-service profile; routes are auth-only, no permission resource.',
  'training.courses': 'BUG: namespaced training-courses.* derived but no route consumes it; admin training-course APIs gate on students.courses.*/modules.* â€” wire training-courses.* or remove the row.',
  'communication.campaigns': 'Unbuilt: no campaigns API exists yet.',
  'training.assessments': 'Unbuilt: no assessments API exists yet.',
  'project.milestones': 'Unbuilt: no milestones API exists yet.',
  'ai.chatbot': 'chatAssistant routes are auth-only â€” wire chatbot.* or remove the row.',
};

/**
 * Guarded keys that are intentionally NOT grantable through the matrix (super-user /
 * platformSuperUser only). The satisfiability check skips these instead of failing.
 * Anything else a guard requires that no matrix row can produce is a wrong-key bug
 * (a dead route only platformSuperUser can reach) â€” e.g. recruiters.update was one
 * until fixed (deriveApiPermissions emits .edit/.delete/.manage, never .update).
 */
const KNOWN_RESTRICTED_KEYS = {
  'candidates.revokeSalesAgentAttribution':
    'Intentional: revoking sales-agent attribution is elevated; alias maps to itself only, no matrix row grants it.',
  'org.mutate.denied':
    'Intentional: allowlisted denied-mutation audit key; emitted by requirePermissions auditOnDeny, not grantable via matrix.',
};

/** A guarded literal is permission-like if it is a lowercase dotted key (not a role name). */
function isPermissionKey(k) {
  return /^[a-z][\w-]*\./.test(k) && !k.includes(':');
}

/** Guard helpers / call sites whose string-literal args are permission keys. */
const GUARD_FN = [
  'requirePermissions',
  'requireAnyOfPermissions',
  'requirePermissionOrAdministrator',
  'requireAdministratorOrPermission',
  'getGrantingPermissions',
  'hasApiPermissionFromContext',
  'hasApiPermission',
];

/** Parse PERMISSION_SECTIONS -> [{ section, feature, prefix }]. Regex, not TS import. */
function parseMatrixRows(tsSource) {
  const start = tsSource.indexOf('= [', tsSource.indexOf('PERMISSION_SECTIONS'));
  if (start < 0) throw new Error('PERMISSION_SECTIONS array literal not found');
  // Read to the closing "];" of the array (first one after start).
  const end = tsSource.indexOf('];', start);
  const body = tsSource.slice(start + 3, end);

  const rows = [];
  // Section object = has id + label + features:[...]; the features: lookahead disambiguates
  // it from inner feature objects (which have id + label only).
  const sectionRe = /\{\s*id:\s*"([^"]+)",\s*label:\s*"[^"]*",\s*features:\s*\[([\s\S]*?)\]/g;
  let s;
  while ((s = sectionRe.exec(body)) !== null) {
    const sectionId = s[1];
    const featuresBlock = s[2];
    const featRe = /id:\s*"([^"]+)"/g;
    let f;
    while ((f = featRe.exec(featuresBlock)) !== null) {
      const featureId = f[1];
      rows.push({ section: sectionId, feature: featureId, prefix: `${sectionId}.${featureId}` });
    }
  }
  if (!rows.length) throw new Error('Parsed 0 matrix rows â€” regex drift, check roles-permissions.ts shape');
  return rows;
}

/** Recursively collect .js files under dir, skipping tests + node_modules. */
function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.endsWith('.test.js')) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) jsFiles(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Scan backend src/ for every permission key any guard references. */
function collectGuardedKeys() {
  const keys = new Set();
  const stringRe = /['"]([A-Za-z][\w.\-:,]*)['"]/g;
  const fnRe = new RegExp(`(?:${GUARD_FN.join('|')})\\s*\\(([\\s\\S]*?)\\)`, 'g');
  const hasRe = /\.has\(\s*['"]([\w.\-:]+)['"]\s*\)/g;

  for (const file of jsFiles(SRC_DIR)) {
    const src = readFileSync(file, 'utf8');

    let m;
    while ((m = fnRe.exec(src)) !== null) {
      const args = m[1];
      let lit;
      while ((lit = stringRe.exec(args)) !== null) keys.add(lit[1]);
      stringRe.lastIndex = 0;
    }
    while ((m = hasRe.exec(src)) !== null) keys.add(m[1]);
  }
  return keys;
}

/** API permission set granted by a role holding only this row (all 4 actions). */
function rowGrantedApiSet(prefix) {
  return deriveApiPermissions(new Set([`${prefix}:view,create,edit,delete`]));
}

/**
 * Enforced if, for some guarded key K, getGrantingPermissions(K) (the strings that satisfy
 * the guard at runtime) intersects the row's granted set â€” identical to the runtime check.
 */
function findEnforcingKey(prefix, guardedKeys) {
  const granted = rowGrantedApiSet(prefix);
  for (const K of guardedKeys) {
    const satisfiers = getGrantingPermissions(K);
    if (satisfiers.some((p) => granted.has(p))) return K;
  }
  return null;
}

function auditMatrix() {
  if (!existsSync(MATRIX_FILE)) {
    return { missing: true };
  }
  const rows = parseMatrixRows(readFileSync(MATRIX_FILE, 'utf8'));
  const guardedKeys = collectGuardedKeys();

  const enforced = [];
  const dead = [];
  for (const row of rows) {
    const key = findEnforcingKey(row.prefix, guardedKeys);
    if (key) enforced.push({ ...row, enforcedBy: key });
    else dead.push(row);
  }

  // Drift checks
  const deadPrefixes = new Set(dead.map((r) => r.prefix));
  const deadUnexpected = dead.filter((r) => !(r.prefix in INTENTIONALLY_UNENFORCED));
  const staleAllowlist = Object.keys(INTENTIONALLY_UNENFORCED).filter((p) => !deadPrefixes.has(p));

  // Reverse check: every key a guard requires must be PRODUCIBLE by some matrix row.
  // A guarded key no row can grant is a wrong-key bug â€” a route only platformSuperUser
  // can ever reach (e.g. recruiters.update). KNOWN_RESTRICTED_KEYS are the exceptions.
  const universe = new Set();
  for (const row of rows) for (const p of rowGrantedApiSet(row.prefix)) universe.add(p);
  const isSatisfiable = (K) => getGrantingPermissions(K).some((p) => universe.has(p));

  const unsatisfiableGuards = [...guardedKeys]
    .filter(isPermissionKey)
    .filter((K) => !isSatisfiable(K))
    .filter((K) => !(K in KNOWN_RESTRICTED_KEYS));

  // Keep the restricted allowlist honest: an entry is stale if the key is no longer
  // guarded, or became satisfiable (someone aliased/derived it) â€” delete it then.
  const staleRestricted = Object.keys(KNOWN_RESTRICTED_KEYS).filter(
    (K) => !guardedKeys.has(K) || isSatisfiable(K)
  );

  return {
    missing: false,
    rows,
    enforced,
    dead,
    deadUnexpected,
    staleAllowlist,
    guardedKeys,
    unsatisfiableGuards,
    staleRestricted,
  };
}

function main() {
  const r = auditMatrix();

  if (r.missing) {
    const msg =
      `[matrix-assert] Frontend matrix not found: ${MATRIX_FILE}\n` +
      `  Set FRONTEND_DIR to the uat.dharwin.frontend checkout.`;
    if (process.env.STRICT === '1') {
      console.error(msg + '\n  STRICT=1 -> failing.');
      process.exit(1);
    }
    console.warn(msg + '\n  SKIPPING (set STRICT=1 to make this fatal).');
    process.exit(0);
  }

  console.log(
    `[matrix-assert] ${r.rows.length} rows | enforced=${r.enforced.length} | dead=${r.dead.length} | guarded keys=${r.guardedKeys.size} | unsatisfiable=${r.unsatisfiableGuards.length}\n`
  );

  if (r.dead.length) {
    console.log('Dead / UI-only rows (no enforcing guard):');
    for (const row of r.dead) {
      const reason = INTENTIONALLY_UNENFORCED[row.prefix];
      console.log(`  ${reason ? 'â€¢' : 'âœ—'} ${row.prefix}  ${reason ? `(allowlisted: ${reason})` : '<-- UNEXPECTED'}`);
    }
    console.log('');
  }

  let fail = false;

  if (r.deadUnexpected.length) {
    fail = true;
    console.error('FAIL: matrix rows with NO enforcing backend guard and not allowlisted:');
    for (const row of r.deadUnexpected) {
      console.error(`  - ${row.prefix} (derives ${[...rowGrantedApiSet(row.prefix)].join(', ') || 'nothing'})`);
    }
    console.error('  Fix: add a route guard requiring the derived key, alias it in src/config/permissions.js,');
    console.error('       remove the row from the frontend matrix, or (if intentional) add it to');
    console.error('       INTENTIONALLY_UNENFORCED with a reason.\n');
  }

  if (r.staleAllowlist.length) {
    fail = true;
    console.error('FAIL: INTENTIONALLY_UNENFORCED entries that are now ENFORCED (stale â€” delete them):');
    for (const p of r.staleAllowlist) console.error(`  - ${p}`);
    console.error('  These rows gained a guard. Remove them from the allowlist to keep it honest.\n');
  }

  if (r.unsatisfiableGuards.length) {
    fail = true;
    console.error('FAIL: routes guard on permission keys NO matrix row can grant (wrong-key â€” only platformSuperUser passes):');
    for (const K of r.unsatisfiableGuards) console.error(`  - ${K}  (grantors: ${getGrantingPermissions(K).join(', ')})`);
    console.error('  Fix: change the guard to a derivable key (e.g. <resource>.manage), add an alias in');
    console.error('       src/config/permissions.js, or add the key to KNOWN_RESTRICTED_KEYS if it is');
    console.error('       intentionally super-user only.\n');
  }

  if (r.staleRestricted.length) {
    fail = true;
    console.error('FAIL: KNOWN_RESTRICTED_KEYS entries no longer unsatisfiable (stale â€” delete them):');
    for (const K of r.staleRestricted) console.error(`  - ${K}`);
    console.error('  These keys became grantable or are no longer guarded. Remove them from the allowlist.\n');
  }

  if (fail) process.exit(1);
  console.log('OK: every matrix row is enforced or explicitly allowlisted.');
  process.exit(0);
}

// Run when invoked directly; export for the node:test wrapper.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { auditMatrix, parseMatrixRows, collectGuardedKeys, INTENTIONALLY_UNENFORCED };
