/**
 * Round types, in the order a hiring process usually runs them - the UI renders this
 * order, so it is a display decision as well as a validation list.
 *
 * `panel` and `hr` were added because they are the words the scope document uses and
 * neither had a value; before that they had to be filed as `other`.
 *
 * Appending a value here is a BACKEND-FIRST deploy: Joi rejects an unknown round type
 * with a 400, so a frontend offering a value the deployed backend does not know fails
 * the whole schedule request, not just the round field.
 */
export const INTERVIEW_ROUND_TYPES = [
  'screening',
  'technical',
  'panel',
  'hr',
  'behavioral',
  'hiring_manager',
  'culture',
  'final',
  'other',
];

export const INTERVIEW_LINKAGE_STATUSES = [
  'unlinked',
  'legacy_title_candidate',
  'verified',
  'verified_exact_ids',
  'verified_manual',
];

export const INTERVIEW_LINKAGE_SOURCES = [
  'scheduled_with_application',
  'backfill_exact_ids',
  'backfill_title',
  'manual_link',
  'offer_bypass',
  'explicit_application_created',
];

export const SUPPORTED_INTERVIEW_LANGUAGES = ['en'];
