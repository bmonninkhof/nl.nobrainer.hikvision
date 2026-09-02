'use strict';

function parseBoolean(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function normalizeAuthMethod(value) {
  const normalized = String(value || 'automatic').trim().toLowerCase();
  return ['automatic', 'digest', 'basic'].includes(normalized) ? normalized : 'automatic';
}

module.exports = { normalizeAuthMethod, parseBoolean };
