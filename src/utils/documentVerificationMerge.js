const documentS3KeysMatch = (a, b) => {
  const ka = String(a || '').trim();
  const kb = String(b || '').trim();
  return Boolean(ka && kb && ka === kb);
};

/**
 * Reads hand the client a presigned URL in `url` (see getCandidateByOwnerForMe), and a form that
 * PATCHes the row back echoes it. Persisting it replaces the canonical S3 URL with one that expires,
 * so anything reading `documents[].url` directly breaks a week later. Drop the signature.
 */
const stripPresignedQuery = (url) => {
  const raw = String(url || '').trim();
  if (!raw || !/[?&]X-Amz-(Signature|Credential)=/i.test(raw)) return raw;
  const cut = raw.indexOf('?');
  return cut > 0 ? raw.slice(0, cut) : raw;
};

/** New uploads and file replacements must re-enter the verification queue. */
const resetDocumentVerification = (doc) => ({
  ...doc,
  status: 0,
  adminNotes: undefined,
  verifiedAt: undefined,
  verifiedBy: undefined,
});

/** Keep approval state only when the underlying S3 object is unchanged. */
const carryDocumentVerification = (out, prev) => ({
  ...out,
  status: typeof out.status === 'number' ? out.status : typeof prev.status === 'number' ? prev.status : 0,
  adminNotes: out.adminNotes !== undefined ? out.adminNotes : prev.adminNotes,
  verifiedAt: out.verifiedAt !== undefined ? out.verifiedAt : prev.verifiedAt,
  verifiedBy: out.verifiedBy !== undefined ? out.verifiedBy : prev.verifiedBy,
});

/**
 * When PATCH sends documents without S3 keys (e.g. frontend only sent label+url), keep stored keys/metadata.
 * Matches rows by label (first unused match per label). Re-uploads with a new S3 key reset verification to pending.
 */
const mergeDocumentsPreserveKeys = (existingDocs = [], incomingDocs = []) => {
  if (!Array.isArray(incomingDocs)) return existingDocs;
  const pool = (existingDocs || []).map((d) => {
    const plain = d?.toObject ? d.toObject() : { ...d };
    return { ...plain, _merged: false };
  });
  return incomingDocs.map((inc) => {
    const incLabel = (inc.label || '').trim();
    let pi = pool.findIndex(
      (p) =>
        !p._merged &&
        (p.label || '').trim() === incLabel &&
        (String(inc.key || '') === String(p.key || '') || !inc.key)
    );
    if (pi === -1) {
      pi = pool.findIndex((p) => !p._merged && (p.label || '').trim() === incLabel);
    }
    // No stored counterpart: still drop an echoed signature rather than persisting an expiring URL.
    if (pi === -1) {
      return resetDocumentVerification(inc.url ? { ...inc, url: stripPresignedQuery(inc.url) } : inc);
    }
    const prev = pool[pi];
    pool[pi] = { ...prev, _merged: true };
    const out = { ...inc };
    if (prev.key && (!inc.key || String(inc.key).trim() === '')) {
      out.key = prev.key;
    }
    if (prev.originalName && !inc.originalName) out.originalName = prev.originalName;
    if (!(out.size > 0) && prev.size) out.size = prev.size;
    if (!out.mimeType && prev.mimeType) out.mimeType = prev.mimeType;
    if (!out.type && prev.type) out.type = prev.type;
    const sameObject = documentS3KeysMatch(out.key, prev.key);
    // Same object → the stored URL is authoritative. The incoming one is whatever the client was
    // last handed, which for self-service forms is a presigned URL that expires.
    if (prev.url && (!inc.url || sameObject || /localhost|127\.0\.0\.1/i.test(String(inc.url)))) {
      out.url = prev.url;
    } else {
      out.url = stripPresignedQuery(out.url);
    }
    // Slot stamps live on the server. A client that omits them (every current caller does) must not
    // silently un-slot the resume row — that is what made the next upload append a duplicate.
    if (sameObject) {
      if (prev.logicalSlot && !out.logicalSlot) out.logicalSlot = prev.logicalSlot;
      if (prev.slotVersion && !out.slotVersion) out.slotVersion = prev.slotVersion;
    }
    if (sameObject) {
      return carryDocumentVerification(out, prev);
    }
    return resetDocumentVerification(out);
  });
};

export {
  documentS3KeysMatch,
  resetDocumentVerification,
  carryDocumentVerification,
  mergeDocumentsPreserveKeys,
};
