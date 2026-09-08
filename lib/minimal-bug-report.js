'use strict';

function createMinimalBugReport(manifest = {}, errorCode = 'UNKNOWN') {
  return {
    success: true,
    report: JSON.stringify({
      reportType: 'Hikvision minimal bug report',
      createdAt: new Date().toISOString(),
      privacy: { note: 'This fallback report contains no device or account details.' },
      app: {
        id: manifest.id || 'nl.nobrainer.hikvision',
        version: manifest.version || 'unknown',
        sdk: manifest.sdk || 3,
      },
      driver: { id: 'hikvision-camnvr', connection: 'local_isapi' },
      diagnostics: {
        status: 'limited',
        stage: 'device-report-generation',
        errorCode: String(errorCode || 'UNKNOWN').slice(0, 80),
      },
    }, null, 2),
  };
}

module.exports = { createMinimalBugReport };
