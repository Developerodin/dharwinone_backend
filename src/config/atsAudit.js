/**
 * ATS audit adapter configuration defaults.
 * Dual-write flags default off — enable via env when migrating legacy consumers.
 */
export const ATS_AUDIT_DEFAULTS = {
  dualWriteRecruiter: false,
  dualWritePlacement: false,
};
