'use strict';

function getUserErrorKey(error = {}) {
  const statusCode = Number(error.statusCode);
  const code = String(error.code || '').toUpperCase();
  const message = String(error.message || '').toLowerCase();

  if (statusCode === 401 || message.includes('username or password')) {
    return 'errors.invalid_credentials';
  }
  if (statusCode === 403) return 'errors.insufficient_permissions';
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)
    || message.includes('certificate')) {
    return 'errors.tls_certificate';
  }
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)
    || message.includes('timed out')) {
    return 'errors.device_unreachable';
  }
  return 'errors.connection_unavailable';
}

function getUserErrorMessage(error, translate) {
  return translate(getUserErrorKey(error));
}

module.exports = { getUserErrorKey, getUserErrorMessage };
