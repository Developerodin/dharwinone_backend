import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import pick from '../utils/pick.js';
import externalJobService from '../services/externalJob.service.js';
import apolloService from '../services/apollo.service.js';
import ApolloEnrichment from '../models/apolloEnrichment.model.js';
import SavedHrContact from '../models/savedHrContact.model.js';
import config from '../config/config.js';

const search = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const body = req.body || {};
  const rawSource = body.source || 'active-jobs-db';
  const sourceAliases = { 'linkedin-jobs-api': 'linkedin-job-search-api' };
  const source = sourceAliases[rawSource] || rawSource;
  if (!['active-jobs-db', 'linkedin-job-search-api'].includes(source)) {
    return res.status(httpStatus.BAD_REQUEST).send({ message: 'Invalid source. Use active-jobs-db or linkedin-job-search-api.' });
  }
  const filters = {
    job_title: body.job_title || '',
    job_location: body.job_location || '',
    offset: body.offset ?? 0,
    date_posted: body.date_posted || '24h',
    remote: body.remote,
  };
  const jobs = await externalJobService.searchFromAPI(filters, source, userId);
  res.send({ jobs, total: jobs.length, hasMore: jobs.length >= 10 });
});

const save = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const job = await externalJobService.saveJob(userId, req.body);
  res.status(httpStatus.OK).send(job);
});

const listSaved = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const options = pick(req.query, ['limit', 'page']);
  const result = await externalJobService.getSavedJobs(userId, options);
  res.send(result);
});

const unsave = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const { externalId } = req.params;
  const source = req.query.source;
  await externalJobService.unsaveJob(userId, externalId, source);
  res.status(httpStatus.NO_CONTENT).send();
});

const APOLLO_LOCKED_EMAIL_PATTERN = /email_not_unlocked|emailnotunlocked|locked@|noemail/i;

/** Normalise a location string into a compact, stable cache key segment. */
function normaliseLocation(location) {
  if (!location || /^remote$/i.test(location.trim())) return '';
  return location.toLowerCase().replace(/\s+/g, ' ').trim();
}

const enrichJob = catchAsync(async (req, res) => {
  const { company, externalId, location } = req.body || {};
  if (!company || !company.trim() || !externalId) {
    return res.status(httpStatus.BAD_REQUEST).send({ message: 'company and externalId are required.' });
  }

  const locKey = normaliseLocation(location);
  // Compound key so "Google US" and "Google India" are cached independently
  const companyKey = locKey
    ? `${company.toLowerCase().trim()}::${locKey}`
    : company.toLowerCase().trim();

  const cached = await ApolloEnrichment.findOne({ companyKey });
  if (cached && cached.expiresAt && cached.expiresAt > new Date()) {
    return res.send({ contacts: cached.contacts });
  }

  const searchResult = await apolloService.searchHRContacts(company, location || null);
  if (!searchResult.success) {
    console.error('[enrichJob] Apollo search failed for company=%s location=%s error=%s', company, location, searchResult.error);
    return res.status(httpStatus.BAD_GATEWAY).send({ message: searchResult.error || 'Apollo search failed.' });
  }

  const people = searchResult.people || [];
  if (people.length === 0) {
    return res.send({ contacts: [] });
  }

  const webhookSecret = config.apollo.webhookSecret || 'default';
  const webhookUrl = `${config.backendPublicUrl}/v1/external-jobs/webhook/apollo/${webhookSecret}`;
  // bulk_match accepts max 10 people per request
  const enrichResult = await apolloService.enrichContacts(
    people.slice(0, 10).map((p) => p.id),
    webhookUrl
  );

  if (!enrichResult.success) {
    return res.status(httpStatus.BAD_GATEWAY).send({ message: enrichResult.error || 'Apollo enrichment failed.' });
  }

  const matches = enrichResult.matches || [];
  if (matches.length === 0) {
    return res.send({ contacts: [] });
  }

  const contacts = matches.map((m) => {
    const rawEmail = m.email || '';
    const email = rawEmail && !APOLLO_LOCKED_EMAIL_PATTERN.test(rawEmail) ? rawEmail : '';

    // Phones may already be in the bulk_match response if Apollo has them cached
    const rawPhones = Array.isArray(m.phone_numbers) ? m.phone_numbers : [];
    const phoneNumbers = rawPhones.slice(0, 10).map((p) => ({
      rawNumber: p.raw_number || '',
      sanitizedNumber: p.sanitized_number || '',
      typeCd: p.type_cd || '',
    }));

    // Build a human-readable location string from city/state/country
    const locationParts = [m.city, m.state, m.country].filter(Boolean);
    const location = locationParts.join(', ');

    console.info('[enrichJob] contact:', m.first_name, '| phones:', phoneNumbers.length, '| linkedin:', m.linkedin_url || 'none');

    return {
      apolloId: m.id,
      firstName: m.first_name || '',
      lastName: m.last_name || '',
      title: m.title || '',
      email,
      phoneFetched: phoneNumbers.length > 0,
      phoneNumbers,
      linkedinUrl: m.linkedin_url || '',
      location,
    };
  });

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  try {
    await ApolloEnrichment.findOneAndUpdate(
      { companyKey },
      { companyKey, contacts, searchedAt: new Date(), expiresAt },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Concurrent upsert race — result is already cached, proceed with contacts we have
  }

  return res.send({ contacts });
});

const apolloWebhook = catchAsync(async (req, res) => {
  const { id, phone_numbers: phoneNumbers } = req.body || {};
  if (id && Array.isArray(phoneNumbers) && phoneNumbers.length > 0) {
    const mappedPhones = phoneNumbers.slice(0, 10).map((p) => ({
      rawNumber: p.raw_number || '',
      sanitizedNumber: p.sanitized_number || '',
      typeCd: p.type_cd || '',
    }));
    await ApolloEnrichment.updateMany(
      { 'contacts.apolloId': id },
      {
        $set: {
          'contacts.$[c].phoneFetched': true,
          'contacts.$[c].phoneNumbers': mappedPhones,
        },
      },
      { arrayFilters: [{ 'c.apolloId': id }] }
    );
  }
  return res.status(httpStatus.OK).send({ received: true });
});

const saveHrContact = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const { apolloId, firstName, lastName, title, email, phoneNumbers, linkedinUrl, location, companyName } = req.body || {};
  if (!apolloId) return res.status(httpStatus.BAD_REQUEST).send({ message: 'apolloId is required.' });

  const contact = await SavedHrContact.findOneAndUpdate(
    { userId, apolloId },
    { userId, apolloId, firstName: firstName || '', lastName: lastName || '', title: title || '', email: email || '', phoneNumbers: phoneNumbers || [], linkedinUrl: linkedinUrl || '', location: location || '', companyName: companyName || '', savedAt: new Date() },
    { upsert: true, new: true }
  );
  res.status(httpStatus.OK).send(contact);
});

const listSavedHrContacts = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const contacts = await SavedHrContact.find({ userId }).sort({ savedAt: -1 }).limit(200);
  res.send({ contacts });
});

const deleteHrContact = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const { apolloId } = req.params;
  await SavedHrContact.deleteOne({ userId, apolloId });
  res.status(httpStatus.NO_CONTENT).send();
});

export default {
  search,
  save,
  listSaved,
  unsave,
  enrichJob,
  apolloWebhook,
  saveHrContact,
  listSavedHrContacts,
  deleteHrContact,
};
