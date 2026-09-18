'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  hashPrivateValue,
  readBugReportSection,
  sanitizeForBugReport,
} = require('../lib/bug-report');
const { createMinimalBugReport } = require('../lib/minimal-bug-report');

test('bugrapport verwijdert netwerk- en accountgegevens', () => {
  const privateValues = ['camera.example.local', 'admin-user', 'top-secret'];
  const report = JSON.stringify(sanitizeForBugReport({
    error: 'Connection to 192.168.0.25 at camera.example.local failed for admin-user',
    detail: 'password=top-secret',
  }, privateValues));
  for (const privateValue of [...privateValues, '192.168.0.25']) {
    assert.equal(report.includes(privateValue), false, privateValue);
  }
  assert.equal(hashPrivateValue('camera.example.local').length, 12);
});

test('reparatiewizard biedt een kopieerbaar privacyveilig rapport', () => {
  const root = path.join(__dirname, '..');
  const compose = JSON.parse(fs.readFileSync(path.join(root, 'drivers/hikvision-camnvr/driver.compose.json')));
  const view = fs.readFileSync(path.join(root, 'drivers/hikvision-camnvr/repair/bug_report.html'), 'utf8');
  const device = fs.readFileSync(path.join(root, 'drivers/hikvision-camnvr/device.js'), 'utf8');
  assert.deepEqual(compose.repair, [{ id: 'bug_report' }]);
  assert.match(view, /get_bug_report/);
  assert.match(view, /setTimeout\(createBugReport, 0\)/);
  assert.match(view, /Create again/);
  assert.match(view, /document\.execCommand\('copy'\)/);
  assert.match(device, /async getBugReport\(\)/);
  assert.match(fs.readFileSync(path.join(root, 'drivers/hikvision-camnvr/driver.js'), 'utf8'), /if \(bugReportPromise\) return bugReportPromise/);
  assert.match(fs.readFileSync(path.join(root, 'drivers/hikvision-camnvr/driver.js'), 'utf8'), /createMinimalBugReport/);
  assert.match(fs.readFileSync(path.join(root, 'drivers/hikvision-camnvr/driver.js'), 'utf8'), /session\.setHandler\('showView', async \(\) => true\)/);
  assert.match(device, /getLocalDisplayDiagnostics/);
  assert.match(device, /getRtspDiagnostics/);
  assert.match(device, /status: 'collecting'/);
  assert.match(device, /refreshLocalDisplayDiagnostics/);
  assert.match(device, /getAuthenticationDiagnostics/);
  assert.match(device, /recentEvents: \[\.\.\.this\.recentEventDiagnostics\]/);
  assert.match(device, /authMethod: normalizeAuthMethod/);
  assert.match(device, /homeyWebRtcProxyEnabled: String\(settings\.video_transport \|\| 'automatic'\) !== 'direct'/);
  assert.match(device, /playerResult: 'not-observable-by-app'/);
  assert.match(device, /videoRegistration: \{ \.\.\.this\.videoRegistration \}/);
  assert.match(device, /this\.videoRegistration\.lastUrlRequestedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(device, /await this\.connect\(newSettings, 'settings-change'\)/);
  assert.doesNotMatch(device, /settings:\s*\{\s*\.\.\.settings/);
});

test('minimaal bugrapport blijft beschikbaar wanneer volledige generatie faalt', () => {
  const result = createMinimalBugReport({
    id: 'nl.nobrainer.hikvision',
    version: '2026.9.8',
    sdk: 3,
  }, 'ECIRCULAR');
  const report = JSON.parse(result.report);
  assert.equal(result.success, true);
  assert.equal(report.app.version, '2026.9.8');
  assert.deepEqual(report.diagnostics, {
    status: 'limited',
    stage: 'device-report-generation',
    errorCode: 'ECIRCULAR',
  });
  assert.doesNotMatch(result.report, /address|username|password/i);
});

test('een defecte rapportsectie levert een waarschuwing op en blokkeert het rapport niet', () => {
  const warnings = [];
  const result = readBugReportSection('video-profiles', () => {
    const error = new Error('Local file was not found');
    error.code = 'ENOENT';
    throw error;
  }, {}, warnings);

  assert.deepEqual(result, {});
  assert.deepEqual(warnings, [{ section: 'video-profiles', errorCode: 'ENOENT' }]);
});

test('een ontbrekende optionele diagnosesectie geeft geen misleidende waarschuwing', () => {
  const warnings = [];
  const result = readBugReportSection('diagnostics', () => {
    const error = new Error('Optional diagnostics are unavailable');
    error.code = 'ENOENT';
    throw error;
  }, { status: 'optional-unavailable' }, warnings, {
    ignoredErrorCodes: ['ENOENT'],
  });

  assert.deepEqual(result, { status: 'optional-unavailable' });
  assert.deepEqual(warnings, []);
});
