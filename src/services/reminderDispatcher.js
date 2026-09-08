import logger from '../config/logger.js';

/**
 * Queue-ready reminder delivery seam. Today it delivers inline with bounded
 * concurrency + a per-send timeout. A future change can swap the body for a
 * queue enqueue without touching callers.
 */

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 10000;

const concurrency = () =>
  Math.max(1, Number(process.env.INTERVIEW_REMINDER_CONCURRENCY) || DEFAULT_CONCURRENCY);

const timeoutMs = () => Math.max(1000, Number(process.env.REMINDER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

const RETRYABLE = new Set(['timeout', 'provider_failure', 'unknown']);

/** @param {string} category @returns {boolean} */
export const isRetryableCategory = (category) => RETRYABLE.has(category);

/**
 * Classify a delivery error into a stored category.
 * @param {*} err
 * @returns {'timeout'|'invalid_recipient'|'template_failure'|'provider_failure'|'unknown'}
 */
export const classifyError = (err) => {
  if (err?.isTimeout) return 'timeout';
  if (err?.isInvalidRecipient) return 'invalid_recipient';
  if (err?.isTemplateError) return 'template_failure';
  if (typeof err?.responseCode === 'number' && err.responseCode >= 500) return 'provider_failure';
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('timed out') || msg.includes('etimedout')) return 'timeout';
  if (msg.includes('econnrefused') || msg.includes('enotfound')) return 'provider_failure';
  return 'unknown';
};

const withTimeout = (value, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error('reminder delivery timed out'), { isTimeout: true })),
      ms
    );
    Promise.resolve(typeof value === 'function' ? value() : value).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });

/**
 * Run `worker` over `items` with at most `limit` in flight. Never aborts on a
 * worker throw.
 */
const runPool = async (items, worker, limit) => {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
};

/**
 * Deliver a reminder to every recipient.
 * @param {Object} job
 * @param {string} job.kind - 'interviewT15' | 'conclusion'
 * @param {Array}  job.recipients - opaque recipient descriptors
 * @param {(recipient:any)=>Promise<void>} job.deliver - sends to one recipient; throws on failure, returns false when deliberately suppressed
 * @returns {Promise<{ok:boolean, delivered:number, skipped:number, errorCategory?:string, error?:string}>}
 */
export const dispatchReminder = async ({ kind, recipients = [], deliver }) => {
  if (!recipients.length) {
    logger.warn(`[reminderDispatcher] ${kind} had no recipients — nothing was sent`);
    return { ok: true, delivered: 0, skipped: 0 };
  }

  let delivered = 0;
  let skipped = 0;
  let firstError = null;
  let firstCategory = null;

  await runPool(
    recipients,
    async (recipient) => {
      try {
        // `false` means the send was deliberately suppressed (recipient opted out).
        // Booking that as a delivery is what let an opted-out interview report `sent`
        // with nothing actually sent.
        const result = await withTimeout(() => deliver(recipient), timeoutMs());
        if (result === false) skipped += 1;
        else delivered += 1;
      } catch (err) {
        const category = classifyError(err);
        if (!firstError) {
          firstError = err?.message || String(err);
          firstCategory = category;
        }
        logger.warn(`[reminderDispatcher] ${kind} delivery failed (${category}): ${err?.message || err}`);
      }
    },
    concurrency()
  );

  // An opt-out is a final answer, not a transient failure — do not retry it.
  if (delivered > 0 || skipped > 0) return { ok: true, delivered, skipped };
  return { ok: false, delivered: 0, skipped: 0, errorCategory: firstCategory, error: firstError };
};
