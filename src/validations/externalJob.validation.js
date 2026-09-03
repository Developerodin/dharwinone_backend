import Joi from 'joi';
import { EXTERNAL_JOB_SOURCES } from '../models/externalJob.model.js';

// Already includes the legacy `linkedin-jobs-api` name, which the API still
// accepts and normalises before writing (externalJob.service normalizeSource).
const SOURCE_INPUTS = EXTERNAL_JOB_SOURCES;

/** Feed rows carry nulls for anything the source omitted, so null stays valid. */
const text = (max) => Joi.string().trim().max(max).allow('', null);
const httpUrl = (max) => Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(max).allow('', null);

// The UI re-posts a job object it already has, which may still carry server-side
// fields (a saved row unsaved from the open preview panel, then saved again).
// Accept them so that flow keeps working, but strip them so a client can never
// set who saved a job, when, or which mirrored Job it points at.
const serverOwned = {
  id: Joi.any().strip(),
  _id: Joi.any().strip(),
  __v: Joi.any().strip(),
  savedAt: Joi.any().strip(),
  savedBy: Joi.any().strip(),
  publishedJobId: Joi.any().strip(),
  createdAt: Joi.any().strip(),
  updatedAt: Joi.any().strip(),
};

const searchExternalJobs = {
  body: Joi.object().keys({
    source: Joi.string().valid(...SOURCE_INPUTS),
    job_title: text(200),
    job_location: text(200),
    offset: Joi.number().integer().min(0).max(10000),
    // `all` is an application value; the service maps it to the widest window the
    // source supports and never forwards it to RapidAPI.
    date_posted: Joi.string().valid('24h', '7d', '6m', 'all'),
    // `''` or omit = all work arrangements (no RapidAPI filter).
    work_arrangement: Joi.string().valid('', 'remote_ok', 'remote_solely', 'remote_both').allow(null),
    // Legacy boolean; when true and work_arrangement is absent, treated as remote_both.
    remote: Joi.boolean().allow(null),
  }),
};

const saveExternalJob = {
  body: Joi.object().keys({
    externalId: Joi.string().trim().min(1).max(300).required(),
    source: Joi.string().valid(...SOURCE_INPUTS).required(),
    title: text(300),
    company: text(300),
    location: text(500),
    locationMeta: Joi.object()
      .keys({
        city: text(120),
        state: text(120),
        country: text(120),
        countryCode: text(10),
      })
      .allow(null),
    description: text(200000),
    jobType: text(120),
    experienceLevel: text(120),
    isRemote: Joi.boolean().allow(null),
    salaryMin: Joi.number().min(0).allow(null),
    salaryMax: Joi.number().min(0).allow(null),
    salaryCurrency: text(16),
    platformUrl: httpUrl(2048),
    postedAt: Joi.date().iso().allow(null),
    timePosted: text(60),
    ...serverOwned,
  }),
};

const getSavedExternalJobs = {
  query: Joi.object().keys({
    limit: Joi.number().integer().min(1).max(100),
    page: Joi.number().integer().min(1),
  }),
};

const unsaveExternalJob = {
  params: Joi.object().keys({
    externalId: Joi.string().trim().min(1).max(300).required(),
  }),
  query: Joi.object().keys({
    source: Joi.string().valid(...SOURCE_INPUTS),
  }),
};

const enrichJob = {
  body: Joi.object().keys({
    company: Joi.string().trim().min(1).max(300).required(),
    externalId: Joi.string().trim().min(1).max(300).required(),
    location: text(300),
  }),
};

const saveHrContact = {
  body: Joi.object().keys({
    apolloId: Joi.string().trim().min(1).max(120).required(),
    firstName: text(120),
    lastName: text(120),
    title: text(200),
    // Apollo returns '' for a contact whose email is still locked.
    email: Joi.string().trim().max(320).email({ tlds: { allow: false } }).allow('', null),
    phoneFetched: Joi.boolean(),
    phoneNumbers: Joi.array()
      .max(50)
      .items(
        Joi.object().keys({
          rawNumber: text(50),
          sanitizedNumber: text(50),
          typeCd: text(50),
        })
      )
      .allow(null),
    linkedinUrl: httpUrl(2048),
    location: text(300),
    companyName: text(300),
    ...serverOwned,
    userId: Joi.any().strip(),
  }),
};

const deleteHrContact = {
  params: Joi.object().keys({
    apolloId: Joi.string().trim().min(1).max(120).required(),
  }),
};

export {
  searchExternalJobs,
  saveExternalJob,
  getSavedExternalJobs,
  unsaveExternalJob,
  enrichJob,
  saveHrContact,
  deleteHrContact,
};
