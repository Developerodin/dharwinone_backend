import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const holidaySchema = mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    /** Optional end date for multi-day festivals. When set, holiday spans [date, endDate] inclusive. */
    endDate: {
      type: Date,
      default: null,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    /** Named holiday set, e.g. "US Holidays 2026". Empty = ungrouped. */
    group: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

holidaySchema.index({ date: -1 });
holidaySchema.index({ endDate: -1 });
holidaySchema.index({ title: 1, date: -1 });

holidaySchema.pre('save', function (next) {
  if (this.date) {
    const d = new Date(this.date);
    d.setUTCHours(0, 0, 0, 0);
    this.date = d;
  }
  if (this.endDate) {
    const e = new Date(this.endDate);
    e.setUTCHours(0, 0, 0, 0);
    this.endDate = e;
  }
  next();
});

holidaySchema.plugin(toJSON);
holidaySchema.plugin(paginate);

/**
 * @typedef Holiday
 */
const Holiday = mongoose.model('Holiday', holidaySchema);

export default Holiday;
