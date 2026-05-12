import { runRetention } from '../services/retention.service.js';
import logger from '../config/logger.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

let handle = null;
let bootTimeout = null;

export function startRetentionEnforcer() {
  if (handle) return;
  bootTimeout = setTimeout(() => {
    runRetention().catch((err) => logger.error('[Retention] failure', { error: err.message }));
    handle = setInterval(() => {
      runRetention().catch((err) => logger.error('[Retention] failure', { error: err.message }));
    }, ONE_DAY_MS);
    handle.unref();
  }, 30 * 60 * 1000);
  bootTimeout.unref();
}

export function stopRetentionEnforcer() {
  if (bootTimeout) {
    clearTimeout(bootTimeout);
    bootTimeout = null;
  }
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}
