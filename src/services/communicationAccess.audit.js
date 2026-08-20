/**
 * Exact-email lookup audit. Spec §6.
 *
 * Written on HIT AND MISS. Logging only misses would make the audit log itself a hit/miss oracle
 * for anyone able to read it — handing back, in bulk and historically and without consuming any
 * rate limit, exactly the distinction the identical 404 withholds.
 *
 * Emails are stored HASHED so the log supports "who probed how much" without becoming a
 * harvestable address list.
 *
 * ACCESS CONTROL: these rows are readable only through existing privileged audit/security
 * tooling. They must not be surfaced by any Communication API, nor by activity-log endpoints
 * available to non-privileged roles.
 */
import crypto from 'node:crypto';
import config from '../config/config.js';
import { persistActivityLogFailSoft } from './activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { LOOKUP_DAILY_CAP } from '../constants/communicationAccess.js';

/**
 * HMAC, not a bare SHA-256 digest. Email addresses are low-entropy and dictionary-constructible
 * (common first/last names against a handful of known domains), so a plain hash is reversible in
 * practice by anyone with read access to the audit collection. A keyed MAC keeps the value
 * deterministic — investigation and correlation still work — while making offline dictionary
 * attacks useless without the secret.
 *
 * Key separation: uses its own secret when configured, otherwise derives one from the JWT secret
 * with a fixed domain label so the same bytes are never used for two purposes.
 */
const auditHashKey = () =>
  config.contactLookup?.hashSecret || `${config.jwt.secret}:contact-lookup-audit-v1`;

export const hashEmail = (normalizedEmail) =>
  crypto.createHmac('sha256', auditHashKey()).update(String(normalizedEmail)).digest('hex');

export const recordLookup = async (req, { emailHash, outcome }) => {
  await persistActivityLogFailSoft(
    String(req?.user?.id || ''),
    {
      audit: {
        action: ActivityActions.CONTACT_LOOKUP,
        entityType: EntityTypes.CONTACT_LOOKUP,
        entityId: emailHash,
        metadata: { outcome },
      },
    },
    req
  );
};

export const dailyLookupCount = async (actorId) => {
  const ActivityLog = (await import('../models/activityLog.model.js')).default;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return ActivityLog.countDocuments({
    actor: actorId,
    action: ActivityActions.CONTACT_LOOKUP,
    createdAt: { $gte: since },
  });
};

export { LOOKUP_DAILY_CAP };
