#!/usr/bin/env node
/**
 * Test runner for `npm test`.
 *
 * The suite is an explicit manifest (scripts/test-manifest.json), not a glob:
 * further *.test.js files exist on disk that are deliberately not in the suite
 * yet. Adding a test means adding its path to the manifest.
 *
 * ponytail: this indirection exists only because the manifest is ~11.5k chars.
 * Inlined into `scripts.test` it blows cmd.exe's 8191-char command-line limit,
 * so `npm test` died on Windows with "The command line is too long." Spawning
 * from Node passes argv straight to CreateProcess and sidesteps the shell.
 * Delete this file if the manifest ever shrinks below the limit.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, '..');
const manifestPath = path.join(scriptDir, 'test-manifest.json');

const files = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(files) || files.length === 0) {
  console.error(`[run-tests] ${manifestPath} is empty or not an array`);
  process.exit(1);
}

// ponytail: most manifest entries are gitignored, so a fresh clone has only the few
// tracked test files. node --test hard-errors on a missing path, which would break
// `npm test` entirely on a clone — so skip what is not on disk and say which.
const present = files.filter((f) => existsSync(path.join(repoRoot, f)));
const absent = files.length - present.length;
if (absent > 0) {
  console.error(`[run-tests] skipping ${absent} manifest entr${absent === 1 ? 'y' : 'ies'} not present on disk`);
}
if (present.length === 0) {
  console.error('[run-tests] no manifest test files found on disk');
  process.exit(1);
}

// Extra argv passes through, so `npm test -- --test-name-pattern=unpaid` works.
//
// ponytail: --test-force-exit because a test child still holds an open handle after
// its tests finish, so `npm test` ran the whole suite and then hung forever. Making
// the SMTP transport lazy (email.service.js getTransport) removed one such handle and
// was not enough. Measured 2026-08-11: with this flag the suite reports 1285 tests and
// exits; without it, exit 124 at an 8-minute timeout with every test already run.
// The ceiling: this hides the remaining handle rather than closing it. To find it,
// bisect the manifest and run each half under a timeout until one half stops exiting.
const args = [
  '--test',
  '--test-force-exit',
  '--experimental-test-module-mocks',
  ...process.argv.slice(2),
  ...present,
];

const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`[run-tests] failed to start: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
