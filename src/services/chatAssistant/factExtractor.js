// uat.dharwin.backend/src/services/chatAssistant/factExtractor.js
//
// Strip authoritative numeric facts from a `fetched` blob produced by
// chatAssistant.service.js#executeFetches. Returns the same data the
// summariser already serialises into the prompt — but in a structured
// shape factRenderer + responseValidator can compare against the LLM
// reply.
//
// Returned shape:
//   {
//     counts: [
//       { kind, label, total, role?, date?, status?, breakdown? },
//       ...
//     ],
//     primary: { ...one of the counts above } | null
//   }


function readPeople(fetched) {
  const data = fetched?.fetch_people;
  if (!data || data.notFound) return null;
  const total = Number(data?.page?.total ?? data?.records?.length ?? 0);
  return { kind: 'fetch_people', label: 'people', total };
}

function readJobs(fetched) {
  const data = fetched?.job_result ?? fetched?.fetch_jobs;
  if (!data) return null;
  const total = Number(
    data.result?.total
    ?? data.authoritativeCount
    ?? data.counts?.total
    ?? data.total
    ?? data.records?.length
    ?? 0,
  );
  const filters = data.query?.filters ?? data.filters ?? null;
  const queryId = data.query?.queryId ?? data.queryId ?? null;
  const originLabel = filters?.jobOrigin === 'external'
    ? 'external jobs'
    : filters?.jobOrigin === 'internal'
      ? 'internal jobs'
      : 'jobs';
  return {
    kind: 'fetch_jobs',
    label: originLabel,
    total,
    filters,
    queryId,
    provenance: data.provenance || 'Job.countDocuments+find',
    authoritative: data.authoritative !== false,
  };
}

/**
 * @param {object} fetched - output of executeFetches
 * @param {string} [lastUserMsg] - last user message, used to bias the
 *   "primary" pick toward whatever the user actually asked for.
 */
export function extractFacts(fetched, lastUserMsg = '') {
  const counts = [];
  const push = (f) => { if (f) counts.push(f); };
  push(readPeople(fetched));
  push(readJobs(fetched));

  let primary = null;
  if (lastUserMsg && counts.length) {
    const txt = lastUserMsg.toLowerCase();
    primary =
      counts.find((c) => c.role && txt.includes(String(c.role).toLowerCase())) ||
      counts.find((c) => c.label && txt.includes(c.label.toLowerCase())) ||
      counts[0];
  } else {
    primary = counts[0] || null;
  }

  return { counts, primary };
}
