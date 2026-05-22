import { resolveCandidateVisibleStatus } from '../constants/atsPipeline.js';

/**
 * Presentation-layer shape for a candidate-facing job application.
 * Hides internal pre-boarding/onboarding ops behind `candidateVisibleStatus`.
 */
export const serializeCandidateApplication = (application, { placementStatus } = {}) => {
  const plain =
    application && typeof application.toJSON === 'function' ? application.toJSON() : application || {};
  return {
    ...plain,
    candidateVisibleStatus: resolveCandidateVisibleStatus({
      applicationStatus: plain.status,
      placementStatus,
    }),
  };
};
