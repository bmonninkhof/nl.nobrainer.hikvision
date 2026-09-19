'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeAuthMethod, parseBoolean } = require('../lib/settings');

test('parseBoolean behandelt opgeslagen checkboxwaarden correct', () => {
  for (const value of [false, 0, '0', 'false', 'FALSE', null, undefined, '']) {
    assert.equal(parseBoolean(value), false, `verwacht false voor ${String(value)}`);
  }
  for (const value of [true, 1, '1', 'true', 'TRUE']) {
    assert.equal(parseBoolean(value), true, `verwacht true voor ${String(value)}`);
  }
});

test('authenticatiemethode accepteert alleen ondersteunde waarden', () => {
  assert.equal(normalizeAuthMethod('digest'), 'digest');
  assert.equal(normalizeAuthMethod('BASIC'), 'basic');
  assert.equal(normalizeAuthMethod('automatic'), 'automatic');
  assert.equal(normalizeAuthMethod('unknown'), 'automatic');
  assert.equal(normalizeAuthMethod(undefined), 'automatic');
});

test('Live-video-instellingen bieden automatische substreamkeuze en RTSP-only-modus', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../drivers/hikvision-camnvr/driver.compose.json'),
  ));
  const settings = manifest.settings.flatMap(group => group.children || []);
  const liveStream = settings.find(setting => setting.id === 'live_stream');
  const videoTransport = settings.find(setting => setting.id === 'video_transport');
  const rtspOnly = settings.find(setting => setting.id === 'rtsp_only');
  const authMethod = settings.find(setting => setting.id === 'auth_method');
  assert.equal(liveStream.value, 'automatic');
  assert.deepEqual(liveStream.values.map(value => value.id), ['automatic', 'substream', 'main']);
  assert.equal(videoTransport.value, 'automatic');
  assert.deepEqual(videoTransport.values.map(value => value.id), ['automatic', 'webrtc', 'direct']);
  assert.equal(rtspOnly.type, 'checkbox');
  assert.equal(rtspOnly.value, false);
  assert.equal(authMethod.value, 'automatic');
  assert.deepEqual(authMethod.values.map(value => value.id), ['automatic', 'digest', 'basic']);
});

test('losse NVR-kanalen bieden een afzonderlijke iPhone/Homey-compatibiliteitsmodus', () => {
  const driver = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../drivers/hikvision-nvr-channel/driver.compose.json',
  )));
  const settings = driver.settings.flatMap(group => group.children || []);
  const videoTransport = settings.find(setting => setting.id === 'video_transport');
  assert.ok(videoTransport);
  assert.deepEqual(
    videoTransport.values.map(value => value.id),
    ['automatic', 'ios', 'webrtc', 'direct'],
  );
});
