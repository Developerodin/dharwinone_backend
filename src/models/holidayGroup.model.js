import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

/**
 * A named holiday set, e.g. "US Holidays 2026". Holidays reference a group by its
 * name string (Holiday.group), so a group can exist with zero dates.
 */
const holidayGroupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    /** Training-profile (Student) members. Assigning the group applies its dates to these. */
    members: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
      default: [],
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
  },
  { timestamps: true }
);

holidayGroupSchema.index({ name: 1, isActive: 1 });

holidayGroupSchema.plugin(toJSON);
holidayGroupSchema.plugin(paginate);

/**
 * @typedef HolidayGroup
 */
const HolidayGroup = mongoose.model('HolidayGroup', holidayGroupSchema);

export default HolidayGroup;
