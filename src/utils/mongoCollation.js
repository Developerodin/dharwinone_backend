/**
 * Locale-aware collation for Mongo sort (otherwise Z–A ignores case conventions;
 * lowercase mixes with uppercase incorrectly).
 */
const collationForSortBy = (sortBy, stringFields = ['name']) => {
  if (!sortBy || typeof sortBy !== 'string') return undefined;
  const primary = sortBy.split(',')[0]?.split(':')[0]?.trim();
  if (stringFields.includes(primary)) {
    return { locale: 'en', strength: 2 };
  }
  return undefined;
};

export { collationForSortBy };
