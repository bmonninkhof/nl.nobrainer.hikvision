'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const flowRoot = path.join(__dirname, '..', '.homeycompose', 'flow');

test('visuele gebeurtenistriggers leveren een afbeeldingstag', () => {
  for (const id of ['VideoMotionStart', 'LineDetectionStart', 'IntrusionDetectionStart', 'RegionEntranceDetectionStart', 'RegionExitingDetectionStart', 'DoorbellPressed']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(flowRoot, 'triggers', `${id}.json`)));
    assert.deepEqual(manifest.tokens.map(token => [token.name, token.type]), [
      ['channelID', 'number'],
      ['snapshot', 'image'],
    ]);
  }
});

test('momentopnameactie kiest apparaat en kanaal en levert een afbeelding', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(flowRoot, 'actions', 'take_snapshot.json')));
  assert.deepEqual(manifest.tokens.map(token => [token.name, token.type]), [['snapshot', 'image']]);
  assert.equal(manifest.args.find(argument => argument.name === 'channel').type, 'autocomplete');
  assert.equal(manifest.args.find(argument => argument.name === 'device').type, 'device');
});

test('camerawidget kan een Flow met de gemaakte momentopname starten', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(flowRoot, 'triggers', 'SnapshotCaptured.json')));
  assert.deepEqual(manifest.tokens.map(token => [token.name, token.type]), [
    ['channelID', 'number'],
    ['snapshot', 'image'],
  ]);

  const driver = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'hikvision-camnvr', 'driver.js'), 'utf8');
  const device = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'hikvision-camnvr', 'device.js'), 'utf8');
  const widgetApi = fs.readFileSync(path.join(__dirname, '..', 'widgets', 'camera-zoom', 'api.js'), 'utf8');
  assert.match(driver, /'SnapshotCaptured'/);
  assert.match(device, /trigger\('SnapshotCaptured', this, \{ channelID: channelId, snapshot: image \}\)/);
  assert.match(widgetApi, /captureWidgetSnapshot\(1\)/);
});
