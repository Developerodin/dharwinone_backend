import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';
import { INTERVIEW_ROUND_TYPES } from '../constants/interviewLinkage.js';

/**
 * A reusable set of weighted scoring criteria.
 *
 * A template is RESOLVED when a round is scheduled and COPIED onto the meeting
 * (Meeting.rubricSnapshot) and, for planned jobs, onto JobApplication.roundPlanSnapshot.
 * Nothing reads a template at evaluation time, so editing one never changes what a past
 * round was scored against — the same reason offer letters snapshot their terms.
 *
 * `appliesTo.roundType` and `isDefault` are catalog filters. They do not auto-apply once
 * a job has interviewRounds; each plan row's templateId is the binding. `appliesTo.jobId`
 * is unused and is not written.
 *
 * Archiving rather than deleting keeps the name and weights resolvable for any snapshot
 * that points back at this template.
 */
const rubricTemplateSchema = mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    criteria: [
      {
        _id: false,
        /** Stable slug. A stored rating references this; renaming it orphans those ratings. */
        key: { type: String, required: true, trim: true },
        label: { type: String, required: true, trim: true },
        /** Percentage. A template's criteria must sum to 100 — enforced in validation + service. */
        weight: { type: Number, required: true, min: 0, max: 100 },
        scaleMin: { type: Number, default: 1 },
        scaleMax: { type: Number, default: 5 },
      },
    ],
    appliesTo: {
      jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
      roundType: { type: String, enum: [...INTERVIEW_ROUND_TYPES, null], default: null },
    },
    /** At most one live default — enforced in the service, not here. */
    isDefault: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  },
  { timestamps: true }
);

rubricTemplateSchema.plugin(toJSON);
rubricTemplateSchema.plugin(paginate);

/**
 * Resolution indexes: every lookup filters on archivedAt then on the appliesTo pair.
 *
 * autoIndex is OFF in production (config.js), so shipping this file does NOT build
 * them. They need a deliberate index-creation step on deploy. Correctness does not
 * depend on them; only latency does.
 */
rubricTemplateSchema.index({ archivedAt: 1, 'appliesTo.jobId': 1, 'appliesTo.roundType': 1 });
rubricTemplateSchema.index({ archivedAt: 1, isDefault: 1 });

const RubricTemplate = mongoose.model('RubricTemplate', rubricTemplateSchema);
export default RubricTemplate;
