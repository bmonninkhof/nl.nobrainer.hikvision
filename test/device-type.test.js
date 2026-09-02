'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isSingleChannelDevice,
  isVideoIntercomDevice,
  isVisDevice,
  supportsRtspOnlyFallback,
} = require('../lib/device-type');

test('camera- en deurbeltypen worden als apparaten met één kanaal herkend', () => {
  for (const type of ['IPCamera', 'DoorBell', 'Door Station', 'video_intercom', 'VIS']) {
    assert.equal(isSingleChannelDevice(type), true, type);
  }
  assert.equal(isSingleChannelDevice('NVR'), false);
});

test('alleen deurbel- en video-intercomtypen krijgen oproepstatuscontrole', () => {
  for (const type of ['DoorBell', 'Door Station', 'video_intercom', 'VIS']) {
    assert.equal(isVideoIntercomDevice(type), true, type);
  }
  for (const type of ['IPCamera', 'NVR']) {
    assert.equal(isVideoIntercomDevice(type), false, type);
  }
});

test('Hikvision VIS wordt exact als video-intercomtype herkend', () => {
  assert.equal(isVisDevice('VIS'), true);
  assert.equal(isVisDevice('vis'), true);
  assert.equal(isVisDevice('NVR'), false);
  assert.equal(isVisDevice('IPCamera'), false);
});

test('RTSP-only herstel is begrensd tot video-intercoms en door de regressie overschreven typen', () => {
  for (const type of ['VIS', 'DoorBell', 'Door Station', 'video_intercom', 'Unknown']) {
    assert.equal(supportsRtspOnlyFallback(type), true, type);
  }
  for (const type of ['', 'IPCamera', 'NVR']) {
    assert.equal(supportsRtspOnlyFallback(type), false, type);
  }
});
