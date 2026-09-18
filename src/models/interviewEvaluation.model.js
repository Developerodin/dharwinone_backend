import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

/**
 * One interviewer's evaluation of one interview round.
 *
 * Replaces the single embedded Meeting.interviewScorecard, where the last person to save
 * destroyed every earlier evaluation with no warning and no history (audit R1). A row is
 * owned by its evaluator: the unique (meeting, evaluator) index means saving twice
 * updates your own row, and a colleague saving creates a second one.
 *
 * `ratings[].key` references Meeting.rubricSnapshot.criteria[].key — it is NOT an enum,
 * because an admin invents the categories. Validation happens against the snapshot on
 * the round, so a key that is not in the snapshot is dropped at write time.
 *
 * weightedScore / coveragePct / isComplete are DERIVED and stored, computed by
 * computeWeightedScore on every write. Stored rather than recomputed on read so a list
 * of rounds does not re-run the maths per row, and so a later change to the formula
 * cannot silently restate a historical score.
 */
const interviewEvaluationSchema = mongoose.Schema(
  {
    meeting: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', required: true, index: true },
    /** Denormalised from the meeting so the round-history query needs one lookup, not two. */
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobApplication',
      default: null,
      index: true,
    },
    /** Server-assigned from the authenticated user. A client can never set this. */
    evaluator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Snapshot, so the history panel still names the interviewer after a rename or deactivation. */
    evaluatorName: { type: String, trim: true, default: '' },
    evaluatorEmail: { type: String, trim: true, default: '' },
    /** Which rubric this was scored against — copied from the round's snapshot. */
    rubricTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'RubricTemplate', default: null },
    rubricTemplateName: { type: String, trim: true, default: '' },
    ratings: [
      {
        _id: false,
        key: { type: String, required: true, trim: true },
        /** null means "not scored yet" — distinct from notApplicable. */
        rating: { type: Number, default: null },
        /** Explicitly out of scope for this round, e.g. Technical on an HR interview. */
        notApplicable: { type: Boolean, default: false },
      },
    ],
    comment: { type: String, trim: true, default: '', maxlength: 2000 },
    /** Derived by computeWeightedScore. 0-100, or null when nothing scorable was rated. */
    weightedScore: { type: Number, default: null },
    /** Share of applicable weight actually rated. Displayed next to weightedScore. */
    coveragePct: { type: Number, default: 0 },
    scoredCount: { type: Number, default: 0 },
    totalCount: { type: Number, default: 0 },
    /** False when any applicable criterion is unrated — the UI must show this (audit R2). */
    isComplete: { type: Boolean, default: false },
    submittedAt: { type: Date, default: null },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  },
  { timestamps: true }
);

interviewEvaluationSchema.plugin(toJSON);

/**
 * The rule that makes panel scoring safe: one row per interviewer per round.
 *
 * autoIndex is OFF in production (config.js), so shipping this file does NOT build this
 * index. It needs a deliberate index-creation step on deploy. Until it exists the upsert
 * still targets a single row by filter, so behaviour is correct — the index is what makes
 * a concurrent double-insert impossible rather than merely unlikely.
 */
interviewEvaluationSchema.index({ meeting: 1, evaluator: 1 }, { unique: true });
/** Round-history read path: every evaluation for an application, oldest first. */
interviewEvaluationSchema.index({ applicationId: 1, submittedAt: 1 });

const InterviewEvaluation = mongoose.model('InterviewEvaluation', interviewEvaluationSchema);
export default InterviewEvaluation;
