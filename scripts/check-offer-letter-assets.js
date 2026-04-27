/* eslint-disable no-console -- CLI */
/**
 * CI/dev: ensure offer-letter PNGs exist in backend assets (PDF build) and frontend public (preview).
 * Run: node scripts/check-offer-letter-assets.js
 * Optional: FRONTEND_ROOT=... when frontend is not ../uat.dharwin.frontend.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const frontendRoot = process.env.FRONTEND_ROOT
  ? path.resolve(process.env.FRONTEND_ROOT)
  : path.resolve(backendRoot, '..', 'uat.dharwin.frontend');

const REQUIRED = ['dharwin-offer-letter-logo.png', 'ceo-signature-harvinder.png'];

function mustExist(label, dir) {
  if (!fs.existsSync(dir)) {
    console.error(`[check-offer-letter-assets] Missing directory: ${label} -> ${dir}`);
    process.exit(1);
  }
}

function checkFile(dir, name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) {
    console.error(`[check-offer-letter-assets] Missing file: ${p}`);
    return false;
  }
  return true;
}

const backDir = path.join(backendRoot, 'src', 'assets', 'offer-letters');
const pubDir = path.join(frontendRoot, 'public', 'assets', 'images');

mustExist('backend offer-letters', backDir);
mustExist('frontend public images', pubDir);

let ok = true;
for (const f of REQUIRED) {
  if (!checkFile(backDir, f)) ok = false;
  if (!checkFile(pubDir, f)) ok = false;
}

if (!ok) {
  console.error('[check-offer-letter-assets] Copy matching PNGs into both locations (see offerLetterPdf.service.js).');
  process.exit(1);
}

console.log('[check-offer-letter-assets] OK:', REQUIRED.join(', '));
