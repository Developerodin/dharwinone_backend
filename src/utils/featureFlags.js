const ENV_PREFIX = 'FF_';

function envKey(flagName) {
  return ENV_PREFIX + flagName.replace(/([A-Z])/g, '_$1').toUpperCase();
}

export function getFeatureFlag(tenantId, flagName) {
  const allowKey = envKey(flagName) + '_TENANTS';
  if (process.env[allowKey]) {
    const list = process.env[allowKey].split(',').map((s) => s.trim());
    return list.includes(String(tenantId));
  }
  return process.env[envKey(flagName)] === 'true';
}
