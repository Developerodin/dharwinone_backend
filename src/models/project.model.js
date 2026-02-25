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
      enum: ['High', 'Medium', 'Low'],
      default: 'Medium',
    },
    assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    assignedTeams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TeamGroup' }],
    tags: [{ type: String, trim: true }],
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

projectSchema.plugin(toJSON);
projectSchema.plugin(paginate);

const Project = mongoose.model('Project', projectSchema);

export default Project;
