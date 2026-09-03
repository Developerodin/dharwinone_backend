/**
 * Which saved external jobs on a page still need their mirrored Job rebuilt.
 *
 * Split out of the list handler so a whole page can be checked with a single
 * `Job.find({ _id: { $in: [...] } })` instead of one `Job.exists` per row. At the old page
 * size that was up to ~100 extra round-trips on every load of the Saved tab.
 *
 * Ids are compared as strings on both sides: the live ids come back from a separate query,
 * so they are different ObjectId instances than the ones on the saved rows, and `===`
 * would call every row broken and re-sync the entire page on every request.
 *
 * @param {Array<{publishedJobId?: unknown}>} docs saved external jobs for one page
 * @param {Array<unknown>} liveJobIds ids of the Jobs that actually still exist
 * @returns {Array} the subset of `docs` whose mirror is missing or dangling
 */
export const selectExternalJobsNeedingMirror = (docs = [], liveJobIds = []) => {
  const live = new Set(liveJobIds.map((id) => String(id)));
  return docs.filter((doc) => !doc.publishedJobId || !live.has(String(doc.publishedJobId)));
};

export default selectExternalJobsNeedingMirror;
