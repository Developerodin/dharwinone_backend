// src/constants/communicationAccess.js
/**
 * Communication contact-discovery access control.
 * Design: docs/superpowers/specs/2026-08-20-communication-contact-discovery-rbac-design.md
 */

/** Full Contact Directory — every eligible user. Spec §2.2. */
export const DIRECTORY_ALL_PERMISSION = 'communication.directory:all';

/** Directory limited to the viewer's currently-attributed referred people. Spec §2.5. */
export const DIRECTORY_REFERRED_PERMISSION = 'communication.directory:referred';

/**
 * Feature flag. MUST be camelCase: envKey() in utils/featureFlags.js inserts `_` before every
 * uppercase char, so 'COMMUNICATION_DIRECTORY_RBAC' would resolve to
 * FF__C_O_M_M_U_N_I_C_A_T_I_O_N___D_I_R_E_C_T_O_R_Y___R_B_A_C and never match.
 * Env var: FF_COMMUNICATION_DIRECTORY_RBAC=true
 */
export const COMMUNICATION_DIRECTORY_FLAG = 'communicationDirectoryRbac';

/** slugifyRole('Sales Agent') and every other spelling. Never match the role by name. Spec §2.2. */
export const SALES_AGENT_ROLE_SLUG = 'salesagent';

/** Exact-email lookups permitted per user per rolling 24h. Spec §6. */
export const LOOKUP_DAILY_CAP = 200;
