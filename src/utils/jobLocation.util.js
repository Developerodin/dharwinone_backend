import { CountryStateCity } from '@tansuasici/country-state-city';

/** ISO2 aliases for common abbreviations not resolved by searchLocations alone. */
const COUNTRY_ALIASES = new Map([
  ['usa', 'US'],
  ['us', 'US'],
  ['u.s.a.', 'US'],
  ['u.s.', 'US'],
  ['america', 'US'],
  ['united states', 'US'],
  ['united states of america', 'US'],
  ['uae', 'AE'],
  ['u.a.e.', 'AE'],
  ['uk', 'GB'],
  ['u.k.', 'GB'],
  ['great britain', 'GB'],
  ['england', 'GB'],
]);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeLocationKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const locationWordBoundaryRegex = (term) => ({
  $regex: `\\b${escapeRegex(term)}\\b`,
  $options: 'i',
});

const exactFieldRegex = (term) => ({
  $regex: `^${escapeRegex(term)}$`,
  $options: 'i',
});

function countryTextFallbackTerms(countryCode, countryName) {
  const terms = new Set();
  if (countryName) terms.add(countryName);
  if (countryCode === 'AE') {
    terms.add('UAE');
    terms.add('U.A.E.');
    terms.add('United Arab Emirates');
  }
  if (countryCode === 'US') {
    terms.add('USA');
    terms.add('U.S.A.');
    terms.add('United States');
    terms.add('United States of America');
  }
  return [...terms];
}

function resolveCountry(name) {
  const key = normalizeLocationKey(name);
  if (!key) return null;

  const aliasCode = COUNTRY_ALIASES.get(key);
  if (aliasCode) {
    const c = CountryStateCity.getCountryByIso2(aliasCode);
    if (c) return { countryCode: c.iso2, countryName: c.name };
  }

  const results = CountryStateCity.searchLocations(name, { entityTypes: ['country'], limit: 5 });
  const exact = results.find((r) => r.entityType === 'country' && normalizeLocationKey(r.name) === key);
  const hit = exact || results.find((r) => r.entityType === 'country' && r.matchReason === 'canonical-exact');
  if (hit) return { countryCode: hit.countryCode, countryName: hit.name };
  return null;
}

function resolveState(name, countryCode) {
  if (!countryCode) return null;
  const key = normalizeLocationKey(name);
  if (!key) return null;

  const results = CountryStateCity.searchLocations(name, {
    entityTypes: ['state'],
    countryCode,
    limit: 5,
  });
  const hit =
    results.find((r) => r.entityType === 'state' && normalizeLocationKey(r.name) === key) ||
    results.find((r) => r.entityType === 'state' && r.matchReason === 'canonical-exact');
  if (!hit) return null;
  return { stateName: hit.name, countryCode: hit.countryCode };
}

function resolveCity(name, countryCode) {
  const key = normalizeLocationKey(name);
  if (!key) return null;

  const opts = { entityTypes: ['city'], limit: 5 };
  if (countryCode) opts.countryCode = countryCode;

  const results = CountryStateCity.searchLocations(name, opts);
  const hit =
    results.find((r) => r.entityType === 'city' && normalizeLocationKey(r.name) === key) ||
    results.find((r) => r.entityType === 'city' && r.matchReason === 'canonical-exact');
  if (!hit) return null;

  const country = CountryStateCity.getCountryByIso2(hit.countryCode);
  return {
    cityName: hit.name,
    stateName: hit.stateName || undefined,
    countryCode: hit.countryCode,
    countryName: country?.name,
  };
}

/**
 * Resolve a browse-jobs location filter term to geographic scope (city → state → country).
 * Falls back to plain text when not in the dataset.
 */
export function resolveLocationSearch(term) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return null;
  if (/^remote$/i.test(trimmed)) {
    return { kind: 'remote', searchTerm: trimmed };
  }

  const key = normalizeLocationKey(trimmed);
  const aliasCode = COUNTRY_ALIASES.get(key);
  if (aliasCode) {
    const c = CountryStateCity.getCountryByIso2(aliasCode);
    if (c) {
      return {
        kind: 'country',
        countryCode: c.iso2,
        countryName: c.name,
        searchTerm: trimmed,
      };
    }
  }

  const cityHit = resolveCity(trimmed);
  if (cityHit) {
    return { kind: 'city', ...cityHit, searchTerm: trimmed };
  }

  const stateResults = CountryStateCity.searchLocations(trimmed, { entityTypes: ['state'], limit: 5 });
  const stateHit =
    stateResults.find((r) => r.entityType === 'state' && normalizeLocationKey(r.name) === key) ||
    stateResults.find((r) => r.entityType === 'state' && r.matchReason === 'canonical-exact');
  if (stateHit) {
    const country = CountryStateCity.getCountryByIso2(stateHit.countryCode);
    return {
      kind: 'state',
      stateName: stateHit.name,
      countryCode: stateHit.countryCode,
      countryName: country?.name,
      searchTerm: trimmed,
    };
  }

  const countryRes = resolveCountry(trimmed);
  if (countryRes) {
    return { kind: 'country', ...countryRes, searchTerm: trimmed };
  }

  return { kind: 'text', searchTerm: trimmed };
}

/**
 * Build a MongoDB filter clause for hierarchical location search.
 * Uses indexed locationMeta fields when available; falls back to location text.
 */
export function buildLocationFilterClause(locationTerm) {
  const resolved = resolveLocationSearch(locationTerm);
  if (!resolved) return null;

  if (resolved.kind === 'remote') {
    return { location: { $regex: '^\\s*remote\\s*$', $options: 'i' } };
  }

  if (resolved.kind === 'country') {
    const textClauses = countryTextFallbackTerms(resolved.countryCode, resolved.countryName).map((term) => ({
      location: locationWordBoundaryRegex(term),
    }));
    return {
      $or: [{ 'locationMeta.countryCode': resolved.countryCode }, ...textClauses],
    };
  }

  if (resolved.kind === 'state') {
    return {
      $or: [
        {
          'locationMeta.countryCode': resolved.countryCode,
          'locationMeta.state': exactFieldRegex(resolved.stateName),
        },
        { location: locationWordBoundaryRegex(resolved.stateName) },
      ],
    };
  }

  if (resolved.kind === 'city') {
    const metaClause = {
      'locationMeta.city': exactFieldRegex(resolved.cityName),
    };
    if (resolved.countryCode) metaClause['locationMeta.countryCode'] = resolved.countryCode;

    return {
      $or: [metaClause, { location: locationWordBoundaryRegex(resolved.cityName) }],
    };
  }

  return { location: { $regex: escapeRegex(resolved.searchTerm), $options: 'i' } };
}

/**
 * Parse a job's display location string into normalized metadata when resolvable.
 * Does not mutate or replace the original location text.
 */
export function resolveLocationMeta(locationText) {
  const text = String(locationText || '').trim();
  if (!text || /^remote$/i.test(text)) return null;

  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    let countryCode;
    let country;
    let state;
    let city;

    const countryRes = resolveCountry(parts[parts.length - 1]);
    if (countryRes) {
      countryCode = countryRes.countryCode;
      country = countryRes.countryName;
      parts.pop();
    }

    if (parts.length && countryCode) {
      const stateRes = resolveState(parts[parts.length - 1], countryCode);
      if (stateRes) {
        state = stateRes.stateName;
        parts.pop();
      }
    }

    if (parts.length) {
      const cityRes = resolveCity(parts[0], countryCode);
      if (cityRes) {
        city = cityRes.cityName;
        if (!state && cityRes.stateName) state = cityRes.stateName;
        if (!countryCode && cityRes.countryCode) {
          countryCode = cityRes.countryCode;
          country = cityRes.countryName;
        }
      } else {
        city = parts[0];
      }
    }

    if (city || state || countryCode) {
      const meta = {};
      if (city) meta.city = city;
      if (state) meta.state = state;
      if (country) meta.country = country;
      if (countryCode) meta.countryCode = countryCode;
      return meta;
    }
  }

  const search = resolveLocationSearch(text);
  if (!search || search.kind === 'text' || search.kind === 'remote') return null;

  const meta = {};
  if (search.cityName) meta.city = search.cityName;
  if (search.stateName) meta.state = search.stateName;
  if (search.countryName) meta.country = search.countryName;
  if (search.countryCode) meta.countryCode = search.countryCode;
  return Object.keys(meta).length ? meta : null;
}

/** Attach locationMeta to a job create/update payload when location is present. */
export function applyLocationMetaToPayload(payload) {
  if (!payload || typeof payload !== 'object' || payload.location == null) return;
  const meta = resolveLocationMeta(payload.location);
  if (meta) {
    payload.locationMeta = meta;
  } else {
    delete payload.locationMeta;
  }
}
