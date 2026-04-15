import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const TASK_STATUSES = ['new', 'todo', 'on_going', 'in_review', 'completed'];

const taskCommentSchema = new mongoose.Schema(
  {
    content: { type: String, required: true, trim: true },
    commentedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    taskCode: { type: String, trim: true },
    status: {
      type: String,
      enum: TASK_STATUSES,
      default: 'new',
      index: true,
    },
    dueDate: { type: Date },
    tags: [{ type: String, trim: true }],
    /** Optional hints from AI task breakdown for staffing (e.g. Python, React). */
    requiredSkills: [{ type: String, trim: true }],
    assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },
    likesCount: { type: Number, default: 0 },
    commentsCount: { type: Number, default: 0 },
    imageUrl: { type: String, trim: true },
    order: { type: Number, default: 0 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    comments: {
      type: [taskCommentSchema],
      default: [],
    },
  },
  { timestamps: true }
);

taskSchema.index({ title: 'text', description: 'text' });
taskSchema.index({ projectId: 1, status: 1 });
taskSchema.index({ assignedTo: 1, projectId: 1 });
taskSchema.index({ createdAt: -1 });

taskSchema.plugin(toJSON);

// toJSON plugin strips timestamps by default; tasks need them for lists (e.g. My Tasks "Created").
const originalTaskToJSON = taskSchema.options.toJSON?.transform;
taskSchema.options.toJSON = taskSchema.options.toJSON || {};
taskSchema.options.toJSON.transform = function taskToJSONTransform(doc, ret, options) {
  if (originalTaskToJSON) originalTaskToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

const Task = mongoose.model('Task', taskSchema);

export default Task;
export { TASK_STATUSES };
