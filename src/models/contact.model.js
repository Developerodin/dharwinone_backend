import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const phoneSchema = new mongoose.Schema(
  {
    label: { type: String, enum: ['work', 'mobile', 'other'], default: 'mobile' },
    number: { type: String, required: true, trim: true },
    normalizedNumber: { type: String },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: false }
);

const contactSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    phones: { type: [phoneSchema], default: [] },
    company: { type: String, trim: true, maxlength: 200 },
    email: { type: String, trim: true, lowercase: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 5000 },
    tags: { type: [String], default: [] },
    favorite: { type: Boolean, default: false },
    doNotCall: { type: Boolean, default: false },
    source: { type: String, enum: ['manual', 'from_call', 'imported'], default: 'manual' },
    sourceCallId: { type: mongoose.Schema.Types.ObjectId, ref: 'CallRecord', default: null },
    linkedTo: {
      type: new mongoose.Schema(
        { type: { type: String, enum: ['candidate', 'employee', 'user'] }, id: mongoose.Schema.Types.ObjectId },
        { _id: false }
      ),
      default: null,
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

contactSchema.index({ tenantId: 1, ownerId: 1, deletedAt: 1 });
contactSchema.index({ tenantId: 1, ownerId: 1, favorite: 1 });
contactSchema.index({ tenantId: 1, 'phones.normalizedNumber': 1 });
contactSchema.plugin(toJSON);
contactSchema.plugin(paginate);

const Contact = mongoose.model('Contact', contactSchema);
export default Contact;
