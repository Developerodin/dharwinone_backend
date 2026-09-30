import Joi from 'joi';
import mongoose from 'mongoose';
import { defineTool } from '../../defineTool.js';
import { OFFERS_ACCESS, hiringScope, canSeeOfferCompensation } from './common.js';
import { detailDeps, offerDaysPending, serviceMiss, idOf, NOT_CAPTURED } from './placementDetail.js';

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const MAX_MATCHES = 6;
const DELIVERY_NOTE =
  'Marking an offer Sent makes DharwinOne email the candidate an automatic "You have received an offer" ' +
  `notice; the offer letter itself goes out via Outlook and its delivery is ${NOT_CAPTURED}.`;

/**
 * Who marked the offer Sent in DharwinOne, and when: offer.service updateOfferById logs an offer_sent
 * recruiter activity (and, since the ATS audit cutover, an offer.statusChange ActivityLog row) on every
 * move to Sent. Newest one wins; null when none is on record (older offers).
 * ponytail: metadata.offerId is not indexed; the offer_sent rows are scanned via the activityType index — fine
 * while offer_sent rows stay in the thousands; past that, index metadata.offerId.
 */
async function markedSentBy(offerId, deps) {
  if (!offerId) return null;
  const ids = OBJECT_ID_RE.test(offerId) ? [offerId, new mongoose.Types.ObjectId(offerId)] : [offerId];
  const log = await deps.RecruiterActivityLog
    .findOne({ activityType: 'offer_sent', 'metadata.offerId': { $in: ids } })
    .sort({ createdAt: -1 })
    .select('recruiter createdAt')
    .lean();
  if (!log) return null;
  const who = log.recruiter ? await deps.User.findById(log.recruiter).select('name').lean() : null;
  return { name: who?.name ?? null, at: log.createdAt ?? null };
}

/**
 * One offer the viewer can see: an id through getOfferById (GET /offers/:id, ensureAccess), a code or a
 * candidate through the Offers page search (queryOffers, the list's own visibility).
 */
async function findOffer({ id, offerCode, candidate }, user, deps) {
  if (id) {
    if (!OBJECT_ID_RE.test(id)) return { notFound: 'offer' };
    try {
      const doc = await deps.getOfferById(id, user);
      if (!doc) return { notFound: 'offer' };
      // toObject, not toJSON: the toJSON plugin drops createdAt (preparedAt would read null).
      return { offer: typeof doc.toObject === 'function' ? doc.toObject() : doc };
    } catch (err) {
      return serviceMiss(err, 'offer');
    }
  }
  const search = String(offerCode || candidate).trim();
  const res = await deps.queryOffers({ search }, { page: 1, limit: MAX_MATCHES, sortBy: 'createdAt:desc' }, user);
  const rows = res?.results || [];
  if (!rows.length) return { notFound: 'offer', searchedFor: search };
  const code = offerCode && rows.find((o) => String(o.offerCode || '').toLowerCase() === search.toLowerCase());
  if (code) return { offer: code };
  if (rows.length === 1) return { offer: rows[0] };
  return {
    matches: rows.map((o) => ({
      id: idOf(o), offerCode: o.offerCode ?? null, candidate: o.candidate?.fullName ?? null,
      job: o.job?.title ?? null, status: o.status ?? null,
    })),
  };
}

export default defineTool({
  name: 'get_offer',
  domain: 'hiring',
  kind: 'read',
  description:
    'One job offer in full: who prepared it and when, position, joining date, status and dates, days pending ' +
    'since it was marked Sent, letter status, and compensation (only for viewers allowed to edit offers). Use ' +
    'for "<candidate>\'s offer", "details of offer OFF-2026-0012", "when was X\'s offer sent", "what salary ' +
    'did we offer X", "who sent X\'s offer". Pass id (from list_offers), offerCode, or the candidate name. ' +
    'markedSentBy is who marked it Sent in DharwinOne; the letter itself goes out via Outlook and its ' +
    'delivery is not captured.',
  input: Joi.object({
    id: Joi.string().min(1).max(64).description('Offer id from a list_offers record.'),
    offerCode: Joi.string().min(1).max(40).description('Offer code, e.g. OFF-2026-0012.'),
    candidate: Joi.string().min(1).max(120).description('Candidate name, email or employee id.'),
  }).or('id', 'offerCode', 'candidate'),
  access: OFFERS_ACCESS,
  async execute(args = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = detailDeps(ctx);
    const [found, showCtc] = await Promise.all([findOffer(args, user, deps), canSeeOfferCompensation(user)]);
    if (!found.offer) return found;

    const o = found.offer;
    const cb = o.ctcBreakdown || {};
    // Not gated on sentAt: only Draft → Sent stamps sentAt, but every move to Sent logs offer_sent.
    const sentBy = o.status === 'Draft' ? null : await markedSentBy(idOf(o), deps);
    const out = {
      id: idOf(o),
      offerCode: o.offerCode ?? null,
      candidate: o.candidate?.fullName ?? null,
      job: o.job?.title ?? null,
      position: o.positionTitle || o.job?.title || null,
      status: o.status ?? null,
      placementStatus: o.placementStatus ?? null,
      preparedBy: o.createdBy?.name ?? null,
      preparedAt: o.createdAt ?? null,
      sentAt: o.sentAt ?? null,
      underNegotiationAt: o.underNegotiationAt ?? null,
      acceptedAt: o.acceptedAt ?? null,
      rejectedAt: o.rejectedAt ?? null,
      joiningDate: o.joiningDate ?? null,
      validUntil: o.offerValidityDate ?? null,
      daysPending: offerDaysPending(o, deps.now()),
      workLocation: o.workLocation ?? null,
      letter: {
        generatedAt: o.offerLetterGeneratedAt ?? null,
        savedVersions: o.letterVersionSeq ?? 0,
        // The letter PDF prints the CTC, so its link follows the compensation gate.
        pdfUrl: showCtc ? o.offerLetterUrl ?? null : null,
        ...(o.offerLetterUrl
          ? (showCtc ? {} : { pdfNote: 'A letter PDF is stored, but it shows compensation, which you cannot see.' })
          : { pdfNote: 'No stored PDF link — the letter is generated from the Offers page.' }),
      },
      markedSentBy: sentBy?.name ?? null,
      markedSentAt: sentBy?.at ?? null,
      delivery: DELIVERY_NOTE,
      ...(sentBy || o.status === 'Draft'
        ? {}
        : { markedSentByNote: `who marked this offer Sent — ${NOT_CAPTURED} for this offer` }),
    };
    if (showCtc) {
      out.compensation = {
        base: cb.base ?? null, hra: cb.hra ?? null, specialAllowances: cb.specialAllowances ?? null,
        otherAllowances: cb.otherAllowances ?? null, gross: cb.gross ?? null, currency: cb.currency ?? null,
        compensationType: o.compensationType ?? null,
      };
    } else {
      out.compensationHidden = true;
    }
    return out;
  },
});
