'use strict';

const crypto = require('crypto');

function hashPrivateValue(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function sanitizeText(value, privateValues = []) {
  let text = String(value ?? '');

  privateValues
    .filter(item => item !== undefined && item !== null && String(item).length > 0)
    .map(String)
    .sort((a, b) => b.length - a.length)
    .forEach(item => {
      text = text.split(item).join('[private value hidden]');
    });

  return text
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip hidden]')
    .replace(/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9]{1,4}\b/gi, '[ip hidden]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email hidden]')
    .replace(/(?:password|token|authorization)["'=:\s]+[^,\s"}&]+/gi, '[secret hidden]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [hidden]');
}

function sanitizeForBugReport(value, privateValues = []) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return sanitizeText(value, privateValues);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => sanitizeForBugReport(item, privateValues));

  return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [
    key,
    sanitizeForBugReport(entryValue, privateValues),
  ]));
}

module.exports = { hashPrivateValue, sanitizeForBugReport, sanitizeText };
