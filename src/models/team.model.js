import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const teamMemberSchema = new mongoose.Schema(
  {
    // DEPRECATED (removed in A2): denormalized roster fields. Read via toJSON displayName/displayEmail.
    name: { type: String, trim: true },
    email: { type: String, trim: true },
    memberSinceLabel: { type: String, trim: true }, // e.g. "16 Months"
    projectsCount: { type: Number, default: 0 },
    position: { type: String, trim: true }, // e.g. "Member", "Associate"
    coverImageUrl: { type: String, trim: true },
    avatarImageUrl: { type: String, trim: true },
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'TeamGroup', index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', index: true },
    seniority: { type: String, trim: true, default: 'Member' },
    assignmentMode: {
      type: String,
      enum: ['manual', 'excel-import', 'position-auto', 'ai-suggested'],
      default: 'manual',
      index: true,
    },
    isActive: { type: Boolean, default: true, index: true },
    removedAt: { type: Date, default: null },
    removedReason: { type: String, trim: true },

    // Orphan support — set when the row cannot be linked to an Employee.
    legacyName: { type: String, trim: true },
    legacyEmail: { type: String, trim: true, lowercase: true },
    orphanReason: {
      type: String,
      enum: ['no_email_match', 'ambiguous_match', 'manual_unlink', 'employee_deleted', 'manual_create', null],
      default: null,
    },
    orphanDetectedAt: { type: Date, default: null },

    // Set by the A1 migration on each migrated row — idempotency marker.
    // In the schema so model `.save()` does not strip it under strict mode.
    a1MigratedAt: { type: Date },

    // Frozen role at link/create time — audit/history only. Never auto-updates;
    // live display still derives from the current Employee via deriveDisplayFields.
    roleSnapshot: {
      designation: { type: String, trim: true },
      department: { type: String, trim: true },
      seniority: { type: String, trim: true },
      capturedAt: { type: Date },
    },

    onlineStatus: {
      type: String,
      enum: ['online', 'offline'],
      default: 'online',
    },
    lastSeenLabel: { type: String, trim: true }, // e.g. "8 min", "24 mins"
    isStarred: { type: Boolean, default: false },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

teamMemberSchema.index({ name: 'text', email: 'text', position: 'text' });
teamMemberSchema.index({ createdAt: -1 });
// One ACTIVE linked membership per (team, employee). Inactive history and
// orphan rows (employeeId null) are exempt — not included in the partial index.
teamMemberSchema.index(
  { teamId: 1, employeeId: 1 },
  { unique: true, partialFilterExpression: { isActive: true, employeeId: { $type: 'objectId' } } }
);
teamMemberSchema.index({ teamId: 1, isActive: 1 });

teamMemberSchema.plugin(toJSON);

/**
 * Derives client-facing display fields from a TeamMember-shaped object.
 * Linked rows (populated employeeId) use Employee data; orphan rows use legacy* fields.
 * @param {object} doc - plain object or mongoose doc with employeeId/legacyName/legacyEmail
 * @returns {{displayName:string, displayEmail:string, avatarUrl:(string|null), isOrphan:boolean}}
 */
export const deriveDisplayFields = (doc) => {
  const emp = doc && doc.employeeId;
  const linked = emp && typeof emp === 'object' && emp.fullName;
  if (linked) {
    return {
      displayName: emp.fullName,
      displayEmail: emp.companyAssignedEmail || emp.email || '',
      avatarUrl: (emp.profilePicture && emp.profilePicture.url) || null,
      isOrphan: false,
    };
  }
  return {
    displayName: (doc && doc.legacyName) || '',
    displayEmail: (doc && doc.legacyEmail) || '',
    avatarUrl: null,
    isOrphan: !(doc && doc.employeeId),
  };
};

/**
 * Builds a frozen role snapshot from an Employee. Audit/history only — store it,
 * never recompute it. Returns undefined when no Employee is supplied (orphan rows).
 * @param {object|null} employee - Employee doc/plain object with designation/department
 * @param {string} [seniority] - the TeamMember's seniority (Employee has no seniority field)
 * @returns {{designation:string, department:string, seniority:string, capturedAt:Date}|undefined}
 */
export const buildRoleSnapshot = (employee, seniority) => {
  if (!employee) return undefined;
  return {
    designation: employee.designation || '',
    department: employee.department || '',
    seniority: seniority || '',
    capturedAt: new Date(),
  };
};

// toJSON plugin strips timestamps; roster UI uses createdAt when memberSinceLabel is empty.
const originalTeamMemberToJSON = teamMemberSchema.options.toJSON?.transform;
teamMemberSchema.options.toJSON = teamMemberSchema.options.toJSON || {};
teamMemberSchema.options.toJSON.transform = function teamMemberToJSONTransform(doc, ret, options) {
  if (originalTeamMemberToJSON) originalTeamMemberToJSON(doc, ret, options);
  if (doc.createdAt) ret.createdAt = doc.createdAt.toISOString();
  if (doc.updatedAt) ret.updatedAt = doc.updatedAt.toISOString();
  const display = deriveDisplayFields(doc);
  ret.displayName = display.displayName;
  ret.displayEmail = display.displayEmail;
  ret.avatarUrl = display.avatarUrl;
  ret.isOrphan = display.isOrphan;
  // Backwards-compat shim (1-release window — remove in A2):
  if (ret.name == null) ret.name = display.displayName;
  if (ret.email == null) ret.email = display.displayEmail;
  return ret;
};

const TeamMember = mongoose.model('TeamMember', teamMemberSchema);

export default TeamMember;
