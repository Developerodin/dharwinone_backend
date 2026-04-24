import Joi from 'joi';
import { objectId, password as passwordValidator } from './custom.validation.js';

const document = Joi.object({
  type: Joi.string().valid('Aadhar', 'PAN', 'Bank', 'Passport', 'Other').optional().default('Other'),
  label: Joi.string().optional().trim(),
  url: Joi.string().uri().optional(),
  key: Joi.string().optional().trim(),
  originalName: Joi.string().optional().trim(),
  size: Joi.number().optional().integer().min(0),
  mimeType: Joi.string().optional().trim(),
  status: Joi.number().optional().integer().default(0),
});

const qualification = Joi.object({
  degree: Joi.string().required(),
  institute: Joi.string().required(),
  location: Joi.string().allow('', null),
  startYear: Joi.number().integer().min(1900).max(3000).allow(null),
  endYear: Joi.number().integer().min(1900).max(3000).allow(null),
  description: Joi.string().allow('', null),
});

const experience = Joi.object({
  company: Joi.string().required(),
  role: Joi.string().required(),
  startDate: Joi.date().allow(null),
  endDate: Joi.date().allow(null),
  currentlyWorking: Joi.boolean().default(false),
  description: Joi.string().allow('', null),
});

const skill = Joi.object({
  name: Joi.string().required(),
  level: Joi.string().valid('Beginner', 'Intermediate', 'Advanced', 'Expert').default('Beginner'),
  category: Joi.string().allow('', null),
});

const socialLink = Joi.object({
  platform: Joi.string().required(),
  url: Joi.string().uri().required(),
});

const salarySlip = Joi.object({
  month: Joi.string().optional().trim(),
  year: Joi.number().integer().min(1900).max(2100).optional(),
  documentUrl: Joi.string().uri().optional(),
  key: Joi.string().optional().trim(),
  originalName: Joi.string().optional().trim(),
  size: Joi.number().optional().integer().min(0),
  mimeType: Joi.string().optional().trim(),
});

const singleCandidateSchema = Joi.object().keys({
  owner: Joi.string().custom(objectId),
  role: Joi.string().valid('user').optional(),
  adminId: Joi.when('role', {
    is: 'user',
    then: Joi.string().required().custom(objectId).messages({ 'any.required': 'Admin ID is required when role is user' }),
    otherwise: Joi.forbidden(),
  }),
  fullName: Joi.string().required(),
  email: Joi.string().email().required(),
  phoneNumber: Joi.string()
    .pattern(/^\d{6,15}$/)
    .required()
    .messages({
      'string.pattern.base': 'Phone number must be 6-15 digits',
      'any.required': 'Phone number is required',
    }),
  password: Joi.string().custom(passwordValidator),
  profilePicture: Joi.object({
    url: Joi.string().uri().optional(),
    key: Joi.string().optional().trim(),
    originalName: Joi.string().optional().trim(),
    size: Joi.number().optional().integer().min(0),
    mimeType: Joi.string().optional().trim(),
  }).optional(),
  shortBio: Joi.string().allow('', null),
  sevisId: Joi.string().allow('', null),
  ead: Joi.string().allow('', null),
  visaType: Joi.string().optional().trim(),
  customVisaType: Joi.string().allow('', null),
  countryCode: Joi.string().allow('', null),
  degree: Joi.string().allow('', null),
  supervisorName: Joi.string().allow('', null),
  supervisorContact: Joi.string().allow('', null),
  supervisorCountryCode: Joi.string().allow('', null),
  salaryRange: Joi.string().optional().trim(),
  address: Joi.object({
    streetAddress: Joi.string().optional().trim(),
    streetAddress2: Joi.string().allow('', null),
    city: Joi.string().optional().trim(),
    state: Joi.string().optional().trim(),
    zipCode: Joi.string().optional().trim(),
    country: Joi.string().optional().trim(),
  }).optional(),
  qualifications: Joi.array().items(qualification),
  experiences: Joi.array().items(experience),
  documents: Joi.array().items(document),
  skills: Joi.array().items(skill),
  socialLinks: Joi.array().items(socialLink),
  salarySlips: Joi.array().items(salarySlip),
  joiningDate: Joi.date().optional(),
  position: Joi.string().custom(objectId).optional().allow(null),
  companyAssignedEmail: Joi.string().email().allow('', null),
  companyEmailProvider: Joi.string().valid('gmail', 'outlook', 'unknown', '').allow('', null),
});

const createCandidate = {
  body: Joi.alternatives()
    .try(
      singleCandidateSchema,
      Joi.array().items(singleCandidateSchema).min(1).max(50).messages({
        'array.min': 'At least one candidate is required',
        'array.max': 'Cannot create more than 50 candidates at once',
      })
    )
    .required(),
};

/** Shared with GET /candidates and POST /candidates/export query (export ignores page/limit). */
const listCandidatesQueryKeys = {
  owner: Joi.string().custom(objectId),
  fullName: Joi.string().trim(),
  email: Joi.string().trim(),
  employeeId: Joi.string().trim(),
  agent: Joi.string().trim().allow(''),
  /** Comma-separated agent User ids (assignedAgent filter) */
  agentIds: Joi.string().trim().allow(''),
  sortBy: Joi.string(),
  limit: Joi.number().integer(),
  page: Joi.number().integer(),
  skills: Joi.alternatives().try(Joi.string(), Joi.array().items(Joi.string())),
  skillLevel: Joi.string().valid('Beginner', 'Intermediate', 'Advanced', 'Expert'),
  experienceLevel: Joi.string().valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive'),
  minYearsOfExperience: Joi.number().min(0),
  maxYearsOfExperience: Joi.number().min(0),
  salaryRangeMin: Joi.number().min(0),
  salaryRangeMax: Joi.number().min(0),
  location: Joi.string().trim(),
  city: Joi.string().trim(),
  state: Joi.string().trim(),
  country: Joi.string().trim(),
  degree: Joi.string().trim(),
  visaType: Joi.string().trim(),
  skillMatchMode: Joi.string().valid('all', 'any').default('any'),
  employmentStatus: Joi.string().valid('current', 'resigned', 'all').allow(''),
  /** When true, each list row includes openSopCount (extra DB work per candidate). */
  includeOpenSopCount: Joi.string().valid('true', 'false', '1', '0').optional(),
};

const getCandidates = {
  query: Joi.object().keys(listCandidatesQueryKeys),
};

const getCandidate = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId),
  }),
};

const getCandidateSopStatus = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId),
  }),
};

const getSopOpenOverview = {
  query: Joi.object().keys({
    limit: Joi.number().integer().min(1).max(500),
  }),
};

const updateCandidate = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      fullName: Joi.string(),
      email: Joi.string().email(),
      phoneNumber: Joi.string().pattern(/^\d{6,15}$/).messages({
        'string.pattern.base': 'Phone number must be 6-15 digits',
      }),
      profilePicture: Joi.alternatives()
        .try(
          Joi.object({
            url: Joi.string().uri().optional(),
            key: Joi.string().optional().trim(),
            originalName: Joi.string().optional().trim(),
            size: Joi.number().optional().integer().min(0),
            mimeType: Joi.string().optional().trim(),
          }),
          Joi.valid(null)
        )
        .optional(),
      shortBio: Joi.string().allow('', null),
      sevisId: Joi.string().allow('', null),
      ead: Joi.string().allow('', null),
      visaType: Joi.string().optional().trim(),
      customVisaType: Joi.string().allow('', null),
      countryCode: Joi.string().allow('', null),
      degree: Joi.string().allow('', null),
      supervisorName: Joi.string().allow('', null),
      supervisorContact: Joi.string().allow('', null),
      supervisorCountryCode: Joi.string().allow('', null),
      salaryRange: Joi.string().optional().trim(),
      address: Joi.object({
        streetAddress: Joi.string().optional().trim(),
        streetAddress2: Joi.string().allow('', null),
        city: Joi.string().optional().trim(),
        state: Joi.string().optional().trim(),
        zipCode: Joi.string().optional().trim(),
        country: Joi.string().optional().trim(),
      }).optional(),
      department: Joi.string().trim().optional().allow('', null),
      designation: Joi.string().trim().optional().allow('', null),
      position: Joi.string().custom(objectId).optional().allow(null),
      reportingManager: Joi.string().custom(objectId).optional().allow(null),
      qualifications: Joi.array().items(qualification),
      experiences: Joi.array().items(experience),
      documents: Joi.array().items(document),
      skills: Joi.array().items(skill),
      socialLinks: Joi.array().items(socialLink),
      salarySlips: Joi.array().items(salarySlip),
      companyAssignedEmail: Joi.string().email().allow('', null),
      companyEmailProvider: Joi.string().valid('gmail', 'outlook', 'unknown', '').allow('', null),
    })
    .min(1),
};

/** Same body as updateCandidate, no params (for PATCH /me). */
const updateMyCandidate = {
  body: updateCandidate.body,
};

const deleteCandidate = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId),
  }),
};

const exportCandidate = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId),
  }),
  body: Joi.object().keys({
    email: Joi.string().email().required(),
  }),
};

const exportAllCandidates = {
  query: Joi.object().keys({
    ...listCandidatesQueryKeys,
    /** `csv` single sheet as text; default (omit) = multi-sheet `.xlsx` download */
    format: Joi.string().valid('csv', 'xlsx'),
  }),
  body: Joi.object().keys({
    email: Joi.string().email().optional(),
  }),
};

/** Agent workload report; ignores agent/agentIds (org-wide for employment scope). */
const getAgentAssignmentSummary = {
  query: Joi.object().keys({
    employmentStatus: Joi.string().valid('current', 'resigned', 'all').allow(''),
  }),
};

const addSalarySlip = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    month: Joi.string().required().trim(),
    year: Joi.number().required().integer().min(1900).max(2100),
    documentUrl: Joi.string().uri().required(),
    key: Joi.string().required().trim(),
    originalName: Joi.string().required().trim(),
    size: Joi.number().required().integer().min(0),
    mimeType: Joi.string().required().trim(),
  }).required(),
};

const updateSalarySlip = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
    salarySlipIndex: Joi.number().integer().min(0).required(),
  }),
  body: Joi.object().keys({
    month: Joi.string().optional().trim(),
    year: Joi.number().optional().integer().min(1900).max(2100),
    documentUrl: Joi.string().uri().optional(),
    key: Joi.string().optional().trim(),
    originalName: Joi.string().optional().trim(),
    size: Joi.number().optional().integer().min(0),
    mimeType: Joi.string().optional().trim(),
  })
    .min(1)
    .required(),
};

const deleteSalarySlip = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
    salarySlipIndex: Joi.number().integer().min(0).required(),
  }),
};

const downloadSalarySlip = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
    salarySlipIndex: Joi.number().integer().min(0).required(),
  }),
};

const verifyDocument = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
    documentIndex: Joi.number().integer().min(0).required(),
  }),
  body: Joi.object().keys({
    status: Joi.number().integer().valid(0, 1, 2).required().messages({
      'any.only': 'Status must be 0 (pending), 1 (approved), or 2 (rejected)',
      'any.required': 'Status is required',
    }),
    adminNotes: Joi.string().optional().trim().max(500),
  }).required(),
};

const getDocumentStatus = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
};

const getDocuments = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
};

const shareCandidateProfile = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    email: Joi.string().email().required().messages({
      'string.email': 'Please provide a valid email address',
      'any.required': 'Recipient email is required',
    }),
    withDoc: Joi.boolean().default(false),
  }).required(),
};

const resendVerificationEmail = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
};

const addRecruiterNote = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    note: Joi.string().required().trim().min(1).messages({
      'any.required': 'Note is required',
      'string.empty': 'Note cannot be empty',
    }),
  }),
};

const addRecruiterFeedback = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    feedback: Joi.string().required().trim().min(1).messages({
      'any.required': 'Feedback is required',
      'string.empty': 'Feedback cannot be empty',
    }),
    rating: Joi.number().integer().min(1).max(5).optional(),
  }),
};

const assignRecruiter = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    recruiterId: Joi.string().required().custom(objectId),
  }),
};

const listStudentAgentAssignments = {
  query: Joi.object().keys({}),
};

const listAgentsForFilter = {
  query: Joi.object().keys({}),
};

const assignAgent = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      agentId: Joi.alternatives().try(Joi.string().custom(objectId), Joi.valid(null)).required(),
    })
    .required(),
};

const listCompanyEmailAssignments = {
  query: Joi.object().keys({}),
};

const assignCompanyAssignedEmail = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      companyAssignedEmail: Joi.string().allow('', null),
      companyEmailProvider: Joi.string().valid('gmail', 'outlook', 'unknown', '').allow('', null),
    })
    .required(),
};

const getCompanyEmailSettings = {
  query: Joi.object().keys({}),
};

const patchCompanyEmailSettings = {
  body: Joi.object()
    .keys({
      companyEmailAssignmentEnabled: Joi.boolean().required(),
    })
    .required(),
};

const updateJoiningDate = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    joiningDate: Joi.date().required().messages({
      'any.required': 'Joining date is required',
      'date.base': 'Joining date must be a valid date',
    }),
  }),
};

const updateResignDate = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    resignDate: Joi.date().allow(null).optional().messages({
      'date.base': 'Resign date must be a valid date',
    }),
  }),
};

const updateWeekOff = {
  body: Joi.object().keys({
    candidateIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required().messages({
      'array.min': 'At least one candidate ID is required',
      'any.required': 'Candidate IDs are required',
    }),
    weekOff: Joi.array()
      .items(Joi.string().valid('Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'))
      .unique()
      .required()
      .messages({
        'any.required': 'Week-off days are required',
        'array.unique': 'Week-off days must be unique',
      }),
  }),
};

const getWeekOff = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
};

const assignShift = {
  body: Joi.object()
    .keys({
      candidateIds: Joi.array()
        .items(Joi.string().custom(objectId))
        .min(1)
        .required()
        .messages({
          'array.min': 'At least one candidate ID is required',
          'any.required': 'Candidate IDs are required',
        }),
      shiftId: Joi.string()
        .custom(objectId)
        .required()
        .messages({
          'any.required': 'Shift ID is required',
        }),
    })
    .required(),
};

const referralLeadsQueryKeys = {
  limit: Joi.number().integer().min(1).max(100),
  cursor: Joi.string().trim().allow(''),
  search: Joi.string().trim().allow(''),
  referredByUserId: Joi.string().custom(objectId).allow(''),
  referralContext: Joi.string().valid('SHARE_CANDIDATE_ONBOARD', 'JOB_APPLY').allow(''),
  referralPipelineStatus: Joi.string()
    .valid('profile_complete', 'applied', 'in_review', 'hired', 'rejected', 'pending')
    .allow(''),
  from: Joi.string().trim().allow('').optional(),
  to: Joi.string().trim().allow('').optional(),
};

const getReferralLeads = {
  query: Joi.object().keys(referralLeadsQueryKeys),
};

const getReferralLeadsStats = {
  query: Joi.object().keys(referralLeadsQueryKeys),
};

const postReferralLinkToken = {
  body: Joi.object()
    .keys({
      source: Joi.string().valid('onboard', 'job').required(),
      candidateEmail: Joi.when('source', {
        is: 'onboard',
        then: Joi.string().email().required(),
        otherwise: Joi.string().email().allow('', null).optional(),
      }),
      jobId: Joi.when('source', {
        is: 'job',
        then: Joi.string().custom(objectId).required(),
        otherwise: Joi.string().custom(objectId).allow(null, '').optional(),
      }),
      batchId: Joi.string().trim().max(200).allow('').optional(),
    })
    .required(),
};

const postReferralAttributionOverride = {
  params: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      newReferredByUserId: Joi.string().custom(objectId).required(),
      reason: Joi.string().trim().min(1).max(200).required(),
    })
    .required(),
};

export {
  createCandidate,
  getCandidates,
  getCandidate,
  getReferralLeads,
  getReferralLeadsStats,
  postReferralLinkToken,
  postReferralAttributionOverride,
  getCandidateSopStatus,
  getSopOpenOverview,
  updateCandidate,
  updateMyCandidate,
  deleteCandidate,
  exportCandidate,
  exportAllCandidates,
  getAgentAssignmentSummary,
  addSalarySlip,
  updateSalarySlip,
  deleteSalarySlip,
  downloadSalarySlip,
  verifyDocument,
  getDocumentStatus,
  getDocuments,
  shareCandidateProfile,
  resendVerificationEmail,
  addRecruiterNote,
  addRecruiterFeedback,
  assignRecruiter,
  listStudentAgentAssignments,
  listCompanyEmailAssignments,
  listAgentsForFilter,
  assignAgent,
  assignCompanyAssignedEmail,
  getCompanyEmailSettings,
  patchCompanyEmailSettings,
  updateJoiningDate,
  updateResignDate,
  updateWeekOff,
  getWeekOff,
  assignShift,
};
