'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { getUserErrorKey } = require('../lib/user-error');

const root = path.join(__dirname, '..');

function flattenKeys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' && !Array.isArray(child)
      ? flattenKeys(child, fullKey)
      : [fullKey];
  }).sort();
}

test('alle ondersteunde talen bevatten dezelfde vertalingssleutels', () => {
  const locales = ['en', 'nl', 'de'].map(language => JSON.parse(
    fs.readFileSync(path.join(root, 'locales', `${language}.json`)),
  ));
  const englishKeys = flattenKeys(locales[0]);
  for (const locale of locales.slice(1)) assert.deepEqual(flattenKeys(locale), englishKeys);
});

test('manifest gebruikt de winkelnaam en complete beeldformaten', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose/app.json')));
  assert.equal(manifest.name.en, 'Hikvision');
  assert.equal(manifest.id, 'nl.nobrainer.hikvision');
  assert.equal(manifest.version, '2026.9.5');
  assert.equal(manifest.sdk, 3);
  assert.deepEqual(manifest.platforms, ['local']);
  assert.deepEqual(manifest.permissions, []);
  assert.deepEqual(Object.keys(manifest.images).sort(), ['large', 'small', 'xlarge']);
  assert.equal(manifest.homeyCommunityTopicId, 157226);
  assert.match(manifest.support, /^(?:https:\/\/|mailto:)/);
  assert.match(manifest.bugs.url, /^https:\/\//);
  assert.match(manifest.source, /^https:\/\//);
});

test('package en driver gebruiken dezelfde publicatie-identiteit en lokale verbinding', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose/app.json')));
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const driver = JSON.parse(fs.readFileSync(path.join(root, 'drivers/hikvision-camnvr/driver.compose.json')));
  assert.equal(packageJson.name, manifest.id);
  assert.equal(packageJson.version, manifest.version);
  assert.deepEqual(driver.platforms, ['local']);
  assert.deepEqual(driver.connectivity, ['lan']);
});

test('winkelteksten en changelog bevatten geen interne publicatietekst', () => {
  const readmes = ['README.txt', 'README.nl.txt', 'README.de.txt'];
  for (const filename of readmes) {
    const value = fs.readFileSync(path.join(root, filename), 'utf8');
    assert.doesNotMatch(value, /(^|\n)\s*#/);
    assert.doesNotMatch(value, /https?:\/\//);
    assert.ok(value.trim().split(/\n\s*\n/).length <= 2);
  }

  const changelog = JSON.parse(fs.readFileSync(path.join(root, '.homeychangelog.json')));
  for (const translations of Object.values(changelog)) {
    for (const value of Object.values(translations)) {
      assert.doesNotMatch(value, /certification|certificering|Zertifizierung|review feedback/i);
    }
  }
});

test('technische verbindingsfouten worden naar veilige gebruikersmeldingen vertaald', () => {
  assert.equal(getUserErrorKey({ statusCode: 401 }), 'errors.invalid_credentials');
  assert.equal(getUserErrorKey({ statusCode: 403 }), 'errors.insufficient_permissions');
  assert.equal(getUserErrorKey({ code: 'ECONNREFUSED' }), 'errors.device_unreachable');
  assert.equal(getUserErrorKey({ code: 'CERT_HAS_EXPIRED' }), 'errors.tls_certificate');
  assert.equal(getUserErrorKey(new Error('opaque internal failure')), 'errors.connection_unavailable');
});

test('device lifecycle ruimt zowel bij verwijderen als stoppen op', () => {
  const source = fs.readFileSync(path.join(root, 'drivers/hikvision-camnvr/device.js'), 'utf8');
  assert.match(source, /async onDeleted\(\)/);
  assert.match(source, /async onUninit\(\)/);
  assert.match(source, /async dispose\(\)/);
});

test('statusmogelijkheden hebben condition cards', () => {
  const conditionRoot = path.join(root, '.homeycompose/flow/conditions');
  for (const id of [
    'hik_status_is_connected',
    'hik_alarm_local_is_active',
    'hik_alarm_video_loss_is_active',
    'hik_alarm_line_crossing_is_active',
    'hik_alarm_intrusion_is_active',
    'hik_alarm_region_entrance_is_active',
    'hik_alarm_region_exiting_is_active',
    'hik_event_monitoring_is_active',
  ]) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(conditionRoot, `${id}.json`))));
  }
});
