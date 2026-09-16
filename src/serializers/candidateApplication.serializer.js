import { resolveCandidateLifecycle } from '../constants/atsPipeline.js';

/**
 * Presentation-layer shape for a candidate-facing job application.
 * All candidate-visible lifecycle fields come from one resolver so the badge,
 * the congratulations banner and the API payload can never disagree.
 */
export const serializeCandidateApplication = (
  application,
  { placementStatus, interviewResult, offerStatus, enteredOnboarding, interviews } = {}
) => {
  const plain =
    application && typeof application.toJSON === 'function' ? application.toJSON() : application || {};
  const lifecycle = resolveCandidateLifecycle({
    applicationStatus: plain.status,
    placementStatus,
    interviewResult,
    offerStatus,
    enteredOnboarding,
  });
  const payload = {
    ...plain,
    candidateVisibleStatus: lifecycle.badge,
    candidateLifecycleStage: lifecycle.stage,
    rejectionStage: lifecycle.rejectionStage,
    selectionPersisted: lifecycle.selectionPersisted,
    showCongratulations: lifecycle.showCongratulations,
  };
  if (interviewResult !== undefined) {
    payload.interviewResult = interviewResult;
  }
  if (interviews !== undefined) {
    payload.interviews = interviews;
  }
  return payload;
};
