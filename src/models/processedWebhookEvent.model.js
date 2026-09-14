import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import config from '../config/config.js';

const processedWebhookEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    event: { type: String, required: true },
    roomName: { type: String, default: null, index: true },
    receivedAt: { type: Date, default: Date.now },
    bodyHash: { type: String, required: true },
    status: {
      type: String,
      enum: ['processing', 'processed', 'failed'],
      default: 'processed',
    },
    attempts: { type: Number, default: 1 },
    lastError: { type: String, default: null },
    claimedAt: { type: Date, default: null },
  },
  { timestamps: false }
);

processedWebhookEventSchema.index(
  { receivedAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * config.retention.processedWebhookDays }
);

processedWebhookEventSchema.plugin(toJSON);

const ProcessedWebhookEvent = mongoose.model('ProcessedWebhookEvent', processedWebhookEventSchema);
export default ProcessedWebhookEvent;
