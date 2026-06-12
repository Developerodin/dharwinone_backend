const documentS3KeysMatch = (a, b) => {
  const ka = String(a || '').trim();
  const kb = String(b || '').trim();
  return Boolean(ka && kb && ka === kb);
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
    if (pi === -1) return resetDocumentVerification(inc);
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
    if (prev.url && (!inc.url || /localhost|127\.0\.0\.1/i.test(String(inc.url)))) {
      out.url = prev.url;
    }
    if (documentS3KeysMatch(out.key, prev.key)) {
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
