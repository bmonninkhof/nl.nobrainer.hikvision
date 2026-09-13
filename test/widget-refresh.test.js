'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const widgetManifest = require('../widgets/camera-zoom/widget.compose.json');
const widgetApi = require('../widgets/camera-zoom/api');
const widgetHtml = fs.readFileSync(path.join(root, 'widgets', 'camera-zoom', 'public', 'index.html'), 'utf8');

function createHomey(receiveOptions) {
  const device = {
    getId: () => 'camera-1',
    getRecordingChannels: async () => [{ id: 1, name: '[1] Front' }, { id: 4, name: '[4] Garden' }],
    getWidgetSnapshot: async (channel, options) => {
      receiveOptions(channel, options);
      return { channel };
    },
    captureWidgetSnapshot: async channel => ({ channel }),
  };
  return {
    __: key => key,
    drivers: {
      getDriver: () => ({ getDevices: () => [device] }),
    },
  };
}

test('camera zoom widget offers safe refresh intervals with 15 seconds as default', () => {
  const setting = widgetManifest.settings.find(candidate => candidate.id === 'refresh_interval');
  assert.equal(setting.type, 'dropdown');
  assert.equal(setting.value, '15');
  assert.deepEqual(setting.values.map(value => value.id), ['5', '10', '15', '30', '60']);
  assert.match(widgetHtml, /Homey\.getSettings\(\)\?\.refresh_interval/);
  assert.match(widgetHtml, /refreshSeconds \* 1000/);
});

test('widget API aligns snapshot cache age with the selected interval', async () => {
  let received;
  const homey = createHomey((channel, options) => { received = { channel, options }; });

  await widgetApi.getSnapshot({ homey, body: { deviceId: 'camera-1', refreshSeconds: '5' } });
  assert.deepEqual(received, { channel: 1, options: { maxAgeMs: 4500 } });

  await widgetApi.getSnapshot({ homey, body: { deviceId: 'camera-1', refreshSeconds: 'unsupported' } });
  assert.deepEqual(received, { channel: 1, options: { maxAgeMs: 14500 } });
});

test('zoomwidget exposes detected NVR channels and uses the selected channel', async () => {
  let received;
  const homey = createHomey((channel, options) => { received = { channel, options }; });

  assert.deepEqual(await widgetApi.getChannels({ homey, body: { deviceId: 'camera-1' } }), [
    { id: 1, name: '[1] Front' },
    { id: 4, name: '[4] Garden' },
  ]);
  assert.deepEqual(
    await widgetApi.getSnapshot({ homey, body: { deviceId: 'camera-1', channelId: '4', refreshSeconds: '10' } }),
    { channel: 4 },
  );
  assert.deepEqual(received, { channel: 4, options: { maxAgeMs: 9500 } });
  assert.deepEqual(
    await widgetApi.captureSnapshot({ homey, body: { deviceId: 'camera-1', channelId: '4' } }),
    { channel: 4 },
  );
  assert.match(widgetHtml, /Homey\.api\('POST', '\/channels'/);
  assert.match(widgetHtml, /channelId: selectedChannelId/);
});
