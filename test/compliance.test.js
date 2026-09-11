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
  assert.equal(manifest.version, '2026.9.9');
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

test('pairing gebruikt Homey-apparaatselectie en standaardinstallatie', () => {
  const driver = JSON.parse(fs.readFileSync(path.join(
    root,
    'drivers/hikvision-camnvr/driver.compose.json',
  )));
  assert.deepEqual(driver.pair.map(view => view.id), [
    'start',
    'test_connection',
    'list_devices',
    'add_devices',
  ]);
  assert.equal(driver.pair[0].navigation.next, 'test_connection');
  assert.deepEqual(driver.pair[1].navigation, { prev: 'start', next: 'list_devices' });
  assert.equal(driver.pair[2].template, 'list_devices');
  assert.equal(driver.pair[2].options.singular, true);
  assert.equal(driver.pair[3].template, 'add_devices');

  const pairView = fs.readFileSync(path.join(
    root,
    'drivers/hikvision-camnvr/pair/start.html',
  ), 'utf8');
  assert.doesNotMatch(pairView, /Homey\.createDevice/);
  assert.doesNotMatch(pairView, /id="install"/);
  assert.match(pairView, /getDiscoveredDevices/);
  assert.match(pairView, /icon_type/);
  assert.match(pairView, /Homey\.emit\('updatePairingData'/);
  assert.match(pairView, /Homey\.emit\('getPairingData'/);
  assert.doesNotMatch(pairView, /id="test"/);
  assert.match(pairView, /<form id="pairing-form" autocomplete="on">/);
  assert.match(pairView, /name="username"[\s\S]*?autocomplete="section-hikvision username"/);
  assert.match(pairView, /name="password"[\s\S]*?autocomplete="section-hikvision current-password"/);
  assert.match(pairView, /window\.setInterval\(resetTest, 500\)/);
  assert.match(pairView, /min-height: 48px/);
  assert.match(pairView, /\.discovery-section #discovery-row \{\s*margin: 0 0 \.85rem;/);
  assert.match(pairView, /select\.hy-input-text \{[\s\S]*?appearance: none;/);
  assert.match(pairView, /\.hy-checkbox \{[\s\S]*?min-height: 44px;/);
  assert.match(pairView, /color-scheme: light/);
  assert.match(pairView, /padding: 11px 14px !important/);
  assert.match(pairView, /-webkit-text-fill-color: #111114 !important/);
  assert.match(pairView, /\.hy-nostretch > p:first-child \{\s*margin: 1\.25rem 0 1\.5rem;/);
  assert.doesNotMatch(pairView, /prefers-color-scheme: dark/);

  const driverSource = fs.readFileSync(path.join(
    root,
    'drivers/hikvision-camnvr/driver.js',
  ), 'utf8');
  assert.match(driverSource, /setHandler\('updatePairingData'/);
  assert.match(driverSource, /setHandler\('runPairingTest'[\s\S]*?testConnection\(pairingData\)/);
  assert.match(driverSource, /if \(!pairingDevice\) throw new Error\(this\.homey\.__\('pair\.test_required'\)\)/);
  assert.match(driverSource, /camera: 'camera'/);
  assert.match(driverSource, /doorbell: 'doorbell2'/);
  assert.match(driverSource, /ptz: 'sensor-outdoor-motion'/);
  assert.match(driverSource, /recorder: 'vcr'/);
  assert.match(driverSource, /iconOverride: HOMEY_ICON_OVERRIDES\[iconType\]/);
  assert.doesNotMatch(driverSource, /icon: PAIRING_ICONS\[iconType\]/);

  const testView = fs.readFileSync(path.join(
    root,
    'drivers/hikvision-camnvr/pair/test_connection.html',
  ), 'utf8');
  assert.match(testView, /Homey\.showLoadingOverlay\(\)/);
  assert.match(testView, /Homey\.emit\('runPairingTest'\)/);
  assert.match(testView, /pair\.back_after_failed_test/);
});

test('Hikvision MAC-detectie bevat bekende fabrikantprefixen', () => {
  const prefixes = ['hikvision-mac', 'hikvision-mac-2', 'hikvision-mac-3']
    .flatMap(id => {
      const discovery = JSON.parse(fs.readFileSync(path.join(
        root,
        `.homeycompose/discovery/${id}.json`,
      )));
      assert.equal(discovery.type, 'mac');
      assert.ok(discovery.mac.manufacturer.length <= 32);
      return discovery.mac.manufacturer;
    });
  assert.ok(prefixes.length >= 80);
  assert.ok(prefixes.some(prefix => (
    prefix[0] === 172 && prefix[1] === 203 && prefix[2] === 81
  )));
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
