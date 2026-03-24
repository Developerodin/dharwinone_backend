import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const MAX_HTML_LENGTH = 65536;

const emailTemplateSchema = mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    subject: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    bodyHtml: {
      type: String,
      required: true,
      maxlength: MAX_HTML_LENGTH,
    },
    isShared: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

emailTemplateSchema.plugin(toJSON);

emailTemplateSchema.index({ user: 1, title: 1 });

/**
 * @typedef EmailTemplate
 */
const EmailTemplate = mongoose.model('EmailTemplate', emailTemplateSchema);

export default EmailTemplate;
export { MAX_HTML_LENGTH as EMAIL_TEMPLATE_MAX_HTML_LENGTH };
