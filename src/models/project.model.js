import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    projectManager: { type: String, trim: true },
    clientStakeholder: { type: String, trim: true },
    description: { type: String, trim: true },
    startDate: { type: Date },
    endDate: { type: Date },
    status: {
      type: String,
      enum: ['Inprogress', 'On hold', 'completed'],
      default: 'Inprogress',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium',
    },
    assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    assignedTeams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TeamGroup' }],
    tags: [{ type: String, trim: true }],
    /** Human-readable key prefix for task codes, e.g. "DHRW". Unique. */
    projectKey: { type: String, trim: true, uppercase: true },
    /** Atomic counter: next task sequence number to allocate for this project. */
    nextTaskSeq: { type: Number, default: 1, min: 1 },
    /** Soft target: tasks each group member should receive (AI breakdown + assignment). */
    tasksPerEmployee: { type: Number, min: 1, max: 10 },
    attachments: [{ type: String, trim: true }],
    completedTasks: { type: Number, default: 0 },
    totalTasks: { type: Number, default: 0 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

projectSchema.index({ name: 'text', description: 'text' });
projectSchema.index({ status: 1 });
projectSchema.index({ priority: 1 });
projectSchema.index({ startDate: 1 });
projectSchema.index({ endDate: 1 });
projectSchema.index({ createdAt: -1 });
projectSchema.index({ projectKey: 1 }, { unique: true, sparse: true });

projectSchema.plugin(toJSON);
projectSchema.plugin(paginate);

/**
 * Cascade-delete child rows whenever a Project is removed. Service-layer
 * deleteProjectById already cascades inside a transaction, but these hooks make
 * orphan tasks impossible no matter which delete path is used (admin script,
 * REPL, future code path, etc.). Tasks, breakdown idempotency rows, and
 * assignment runs all hang off projectId and are useless without their parent.
 *
 * `import('./...')` avoids a circular import at module load.
 */
async function cascadeProjectChildren(ids) {
  if (!ids || !ids.length) return;
  const [{ default: Task }, { default: TaskBreakdownIdempotency }, { default: AssignmentRun }, { default: Sprint }] =
    await Promise.all([
      import('./task.model.js'),
      import('./taskBreakdownIdempotency.model.js'),
      import('./assignmentRun.model.js'),
      import('./sprint.model.js'),
    ]);
  await Promise.all([
    Task.deleteMany({ projectId: { $in: ids } }),
    TaskBreakdownIdempotency.deleteMany({ projectId: { $in: ids } }),
    AssignmentRun.deleteMany({ projectId: { $in: ids } }),
    Sprint.deleteMany({ projectId: { $in: ids } }),
  ]);
}

// doc.deleteOne() — fires when service code calls project.deleteOne() on the document
projectSchema.pre('deleteOne', { document: true, query: false }, async function preDocDelete() {
  await cascadeProjectChildren([this._id]);
});

// Project.deleteOne(filter) — query-level single delete
projectSchema.pre('deleteOne', { document: false, query: true }, async function preQueryDeleteOne() {
  const docs = await this.model.find(this.getFilter(), { _id: 1 }).lean();
  await cascadeProjectChildren(docs.map((d) => d._id));
});

// Project.findOneAndDelete(filter)
projectSchema.pre('findOneAndDelete', async function preFindOneAndDelete() {
  const docs = await this.model.find(this.getFilter(), { _id: 1 }).lean();
  await cascadeProjectChildren(docs.map((d) => d._id));
});

// Project.deleteMany(filter) — bulk deletes (e.g. admin scripts)
projectSchema.pre('deleteMany', async function preDeleteMany() {
  const docs = await this.model.find(this.getFilter(), { _id: 1 }).lean();
  await cascadeProjectChildren(docs.map((d) => d._id));
});

const Project = mongoose.model('Project', projectSchema);

export default Project;
