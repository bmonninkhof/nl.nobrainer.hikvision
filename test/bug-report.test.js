'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { hashPrivateValue, sanitizeForBugReport } = require('../lib/bug-report');

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
  assert.match(view, /document\.execCommand\('copy'\)/);
  assert.match(device, /getBugReport\(\)/);
  assert.match(device, /getAuthenticationDiagnostics/);
  assert.match(device, /authMethod: normalizeAuthMethod/);
  assert.doesNotMatch(device, /settings:\s*\{\s*\.\.\.settings/);
});
