import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const SPRINT_STATUSES = ['planning', 'active', 'completed'];

const sprintSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    goal: { type: String, trim: true },
    startDate: { type: Date },
    endDate: { type: Date },
    status: {
      type: String,
      enum: SPRINT_STATUSES,
      default: 'planning',
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

sprintSchema.index({ projectId: 1, status: 1 });
sprintSchema.index({ name: 'text', goal: 'text' });
sprintSchema.index({ createdAt: -1 });

sprintSchema.plugin(toJSON);
sprintSchema.plugin(paginate);

/**
 * When a sprint is removed, tasks keep their row but lose sprint assignment.
 */
async function clearTasksSprintId(sprintIds) {
  if (!sprintIds?.length) return;
  const { default: Task } = await import('./task.model.js');
  await Task.updateMany({ sprintId: { $in: sprintIds } }, { $unset: { sprintId: 1 } });
}

sprintSchema.pre('deleteOne', { document: true, query: false }, async function preDocDelete() {
  await clearTasksSprintId([this._id]);
});

sprintSchema.pre('deleteOne', { document: false, query: true }, async function preQueryDeleteOne() {
  const docs = await this.model.find(this.getFilter(), { _id: 1 }).lean();
  await clearTasksSprintId(docs.map((d) => d._id));
});

sprintSchema.pre('findOneAndDelete', async function preFindOneAndDelete() {
  const docs = await this.model.find(this.getFilter(), { _id: 1 }).lean();
  await clearTasksSprintId(docs.map((d) => d._id));
});

sprintSchema.pre('deleteMany', async function preDeleteMany() {
  const docs = await this.model.find(this.getFilter(), { _id: 1 }).lean();
  await clearTasksSprintId(docs.map((d) => d._id));
});

const Sprint = mongoose.model('Sprint', sprintSchema);

export default Sprint;
export { SPRINT_STATUSES };
