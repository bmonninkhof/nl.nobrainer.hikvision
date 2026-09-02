'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { getUnsupportedAlarmCapabilities } = require('../lib/device-capabilities');

test('VIS-apparaten krijgen geen gebiedsdetectiecapaciteiten', () => {
  assert.deepEqual(getUnsupportedAlarmCapabilities('VIS'), [
    'hik_alarm_region_entrance',
    'hik_alarm_region_exiting',
  ]);
  assert.deepEqual(getUnsupportedAlarmCapabilities('IPCamera'), []);
  assert.deepEqual(getUnsupportedAlarmCapabilities('NVR'), []);
});

test('VIS met defecte ISAPI gebruikt de begrensde RTSP-fallback', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../drivers/hikvision-camnvr/device.js'),
    'utf8',
  );
  assert.match(source, /if \(!supportsRtspOnlyFallback\(cachedType\)\) throw error/);
  assert.match(source, /const forceRtspOnly = parseBoolean\(settings\.rtsp_only\)/);
  assert.match(source, /const fallbackType = cachedType && cachedType\.toUpperCase\(\) !== 'UNKNOWN' \? cachedType : 'VIS'/);
  assert.match(source, /RTSP-only mode is enabled; all ISAPI requests are disabled/);
  assert.match(source, /const channels = rtspOnly \|\| isSingleChannelDevice\(deviceType\)/);
  assert.match(source, /if \(isapiAvailable\) \{\s*await this\.registerCameraImages/);
  assert.match(source, /await this\.registerCameraVideos\(info\.type, client, generation, \{ rtspOnly: !isapiAvailable \}\)/);
  assert.match(source, /if \(isapiAvailable\) \{\s*this\.startConnectionHealthChecks/);
  assert.match(source, /ISAPI temporarily unavailable; automatic recovery is active/);
});

test('automatische VIS-fallback controleert ISAPI opnieuw maar handmatige RTSP-only niet', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../drivers/hikvision-camnvr/device.js'),
    'utf8',
  );
  assert.match(source, /const ISAPI_RECOVERY_INTERVAL = 30000/);
  assert.match(source, /if \(!forceRtspOnly\) this\.startIsapiRecoveryChecks\(client, generation\)/);
  assert.match(source, /parseBoolean\(this\.getSettings\(\)\.rtsp_only\)/);
  assert.match(source, /const detection = await client\.detectCallStatusSupport\(\)/);
  assert.match(source, /recovery-\$\{detection\.source\}/);
  assert.match(source, /await this\.connect\(\)/);
  assert.match(source, /if \(this\.isapiRecoveryTimer\) clearInterval\(this\.isapiRecoveryTimer\)/);
});

test('Live-videodiagnose bevat profielkeuze en RTSP-only-status', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../drivers/hikvision-camnvr/device.js'),
    'utf8',
  );
  assert.match(source, /rtspOnlyConfigured: parseBoolean\(this\.getSettings\(\)\.rtsp_only\)/);
  assert.match(source, /videoProfiles: Object\.fromEntries\(this\.videoProfiles\)/);
  assert.match(source, /const preference = String\(this\.getSettings\(\)\.live_stream \|\| 'automatic'\)/);
});
