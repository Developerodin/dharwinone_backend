import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

export const slugifyRole = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .replace(/[^a-z0-9]/g, '');

const roleSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
      index: true,
    },
    aliases: {
      type: [String],
      default: [],
    },
    previousNames: {
      type: [
        {
          name: { type: String, trim: true },
          renamedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    permissions: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

roleSchema.index({ aliases: 1 });
roleSchema.index({ status: 1 });

roleSchema.post('init', function postInit() {
  this.$locals = this.$locals || {};
  this.$locals.priorName = this.name;
});

roleSchema.pre('save', function preSave(next) {
  if (!this.slug && this.name) this.slug = slugifyRole(this.name);
  if (this.isModified('name') && !this.isNew) {
    const prior = this.$locals?.priorName;
    if (prior && prior !== this.name) {
      this.previousNames = [
        ...(this.previousNames || []),
        { name: prior, renamedAt: new Date() },
      ];
      this.slug = slugifyRole(this.name);
    }
  }
  next();
});

async function captureRenameOnUpdate(next) {
  try {
    const update = this.getUpdate() || {};
    const $set = update.$set || update;
    if (!$set || typeof $set.name !== 'string') return next();
    const filter = this.getFilter();
    const current = await this.model.findOne(filter, { name: 1, previousNames: 1 }).lean();
    if (!current || current.name === $set.name) return next();
    const prevList = Array.isArray(current.previousNames) ? current.previousNames : [];
    const nextUpdate = update.$set ? update : { $set: update };
    nextUpdate.$set = nextUpdate.$set || {};
    nextUpdate.$set.previousNames = [
      ...prevList,
      { name: current.name, renamedAt: new Date() },
    ];
    nextUpdate.$set.slug = slugifyRole($set.name);
    this.setUpdate(nextUpdate);
    return next();
  } catch (err) {
    return next(err);
  }
}

roleSchema.pre('findOneAndUpdate', captureRenameOnUpdate);
roleSchema.pre('updateOne', captureRenameOnUpdate);

/**
 * Bust the registry cache after any mutation. Lazy import avoids the model
 * importing a service module at load time (and the resulting circular import
 * if the registry ever pulls Role directly during init).
 *
 * On delete we additionally fire the broader cascade so ConversationMemory
 * rows pointing at the gone Role get their lastEntities.role* fields unset.
 */
async function bustRegistryOnMutation(doc) {
  try {
    // eslint-disable-next-line import/no-cycle
    const mod = await import('../services/chatAssistant/roleRegistry.js');
    if (typeof mod.bustRoleRegistry === 'function') mod.bustRoleRegistry();
  } catch {
    /* registry not loaded yet — nothing to bust */
  }
}

async function cascadeOnRoleDelete(doc) {
  try {
    // eslint-disable-next-line import/no-cycle
    const cleanup = await import('../services/chatAssistant/entityCleanup.js');
    if (typeof cleanup.cascadeRoleMutation === 'function') {
      await cleanup.cascadeRoleMutation({ roleId: doc?._id });
    }
  } catch {
    /* cleanup module not yet loaded — registry bust already covered upstream */
  }
}

roleSchema.post('save', bustRegistryOnMutation);
roleSchema.post('findOneAndUpdate', bustRegistryOnMutation);
roleSchema.post('updateOne', bustRegistryOnMutation);
roleSchema.post('deleteOne', cascadeOnRoleDelete);
roleSchema.post('findOneAndDelete', cascadeOnRoleDelete);

roleSchema.plugin(toJSON);
roleSchema.plugin(paginate);

// Include createdAt (and updatedAt) in API response for roles
const originalToJSON = roleSchema.options.toJSON?.transform;
roleSchema.options.toJSON = roleSchema.options.toJSON || {};
roleSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

/**
 * Check if name is taken
 * @param {string} name - The role's name
 * @param {ObjectId} [excludeRoleId] - The id of the role to be excluded
 * @returns {Promise<boolean>}
 */
roleSchema.statics.isNameTaken = async function (name, excludeRoleId) {
  const role = await this.findOne({ name, _id: { $ne: excludeRoleId } });
  return !!role;
};

/**
 * @typedef Role
 */
const Role = mongoose.model('Role', roleSchema);

export default Role;
