'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const homeyPath = require.resolve('homey');

require.cache[homeyPath] = {
  id: homeyPath,
  filename: homeyPath,
  loaded: true,
  exports: { Device: class {} },
};
const ParentDevice = require('../drivers/hikvision-camnvr/device');
const ChannelDevice = require('../drivers/hikvision-nvr-channel/device');

const root = path.join(__dirname, '..');

test('NVR-kanaaldriver gebruikt dezelfde cameracapabilities als de hoofd-driver', () => {
  const parent = JSON.parse(fs.readFileSync(path.join(
    root,
    'drivers/hikvision-camnvr/driver.compose.json',
  )));
  const channel = JSON.parse(fs.readFileSync(path.join(
    root,
    'drivers/hikvision-nvr-channel/driver.compose.json',
  )));
  assert.equal(channel.class, 'camera');
  assert.deepEqual(channel.capabilities, parent.capabilities);
  assert.deepEqual(channel.pair.map(view => view.id), ['list_devices', 'add_devices']);
  assert.equal(channel.pair[0].options.singular, false);
});

test('alle apparaatgebonden Flow-kaarten accepteren hoofd- en kanaaldriver', () => {
  const flowRoot = path.join(root, '.homeycompose/flow');
  for (const type of ['actions', 'conditions', 'triggers']) {
    for (const filename of fs.readdirSync(path.join(flowRoot, type))) {
      const source = fs.readFileSync(path.join(flowRoot, type, filename), 'utf8');
      if (!source.includes('"type": "device"')) continue;
      assert.match(
        source,
        /driver_id=hikvision-camnvr\|hikvision-nvr-channel/,
        `${type}/${filename}`,
      );
    }
  }
});

test('NVR deelt kanaalstatus en gebeurtenissen alleen met het juiste kanaal', async () => {
  const states = [];
  const alarms = [];
  const context = {
    channelSubscribers: new Map(),
    error: () => {},
    getChannelState: channelId => ({ channelId, connected: true }),
  };
  const unsubscribe = ParentDevice.prototype.subscribeChannel.call(context, 4, {
    onState: state => states.push(state),
    onAlarm: (...args) => alarms.push(args),
  });
  await new Promise(resolve => setImmediate(resolve));
  await ParentDevice.prototype.notifyChannelAlarm.call(context, 'VideoMotion', 'Start', 3, {});
  await ParentDevice.prototype.notifyChannelAlarm.call(context, 'VideoMotion', 'Start', 4, {
    channelID: 4,
  });
  assert.deepEqual(states, [{ channelId: 4, connected: true }]);
  assert.deepEqual(alarms, [['VideoMotion', 'Start', 4, { channelID: 4 }]]);
  unsubscribe();
  assert.equal(context.channelSubscribers.size, 0);
});

test('kanaalapparaat dwingt zijn eigen kanaal af voor widgets en PTZ', async () => {
  const calls = [];
  const parent = {
    availableChannels: new Map([[7, 'Poort']]),
    ptzChannels: new Set([7]),
    getWidgetSnapshot: async (...args) => {
      calls.push(['snapshot', ...args]);
      return { image: 'jpeg', channelId: 7 };
    },
    movePtz: async args => calls.push(['move', args]),
    stopPtz: async channel => calls.push(['stop', channel]),
    gotoPtzPreset: async (channel, preset) => calls.push(['preset', channel, preset]),
  };
  const context = {
    channelId: 7,
    getName: () => 'Poort',
    requireParent: () => parent,
  };
  const snapshot = await ChannelDevice.prototype.getWidgetSnapshot.call(
    context,
    99,
    { maxAgeMs: 4500 },
  );
  await ChannelDevice.prototype.movePtz.call(context, { channel: 99, pan: 20 });
  await ChannelDevice.prototype.stopPtz.call(context, 99);
  await ChannelDevice.prototype.gotoPtzPreset.call(context, 99, 12);
  assert.equal(snapshot.name, 'Poort');
  assert.deepEqual(calls, [
    ['snapshot', 7, { maxAgeMs: 4500 }],
    ['move', { channel: 7, pan: 20 }],
    ['stop', 7],
    ['preset', 7, 12],
  ]);
});

test('kanaaldriver opent geen extra ISAPI- of eventverbinding', () => {
  const source = fs.readFileSync(path.join(
    root,
    'drivers/hikvision-nvr-channel/device.js',
  ), 'utf8');
  assert.doesNotMatch(source, /new HikvisionClient/);
  assert.doesNotMatch(source, /startAlertStream\(/);
  assert.match(source, /parent\.subscribeChannel/);
  assert.match(source, /MAX_FLOW_SNAPSHOT_IMAGES = 4/);
  assert.match(source, /CAMERA_IMAGE_UPDATE_INTERVAL = 30000/);
});

test('NVR-kanaalbugrapport gebruikt de eigen afspeelinstellingen', () => {
  const source = fs.readFileSync(path.join(
    root,
    'drivers/hikvision-nvr-channel/device.js',
  ), 'utf8');
  assert.match(source, /const channelSettings = this\.getSettings\(\)/);
  assert.match(source, /liveStream: String\(channelSettings\.live_stream \|\| 'automatic'\)/);
  assert.match(source, /videoTransport: String\(channelSettings\.video_transport \|\| 'automatic'\)/);
  assert.match(source, /homeyWebRtcProxyEnabled: String\(channelSettings\.video_transport \|\| 'automatic'\) !== 'direct'/);
  assert.match(source, /playerResult: 'not-observable-by-app'/);
});

test('gewijzigde kanaalinstellingen worden direct voor de actieve video gebruikt', async () => {
  const calls = [];
  const oldSettings = { live_stream: 'automatic', video_transport: 'automatic' };
  const newSettings = { live_stream: 'substream', video_transport: 'direct' };
  const video = {
    registerVideoUrlListener: listener => { calls.push(['listener', listener]); },
    unregister: async () => { calls.push(['unregister']); },
  };
  const context = {
    channelId: 1,
    connectionState: true,
    cameraVideo: null,
    cameraVideoPromise: null,
    videoUrlRequests: { count: 7, lastRequestedAt: '2026-09-15T00:00:00.000Z', lastResult: 'url-provided' },
    getSettings: () => oldSettings,
    getName: () => 'Camera 1',
    requireParent: () => ({
      client: {
        getPreferredStreamingProfile: async (channelId, preference) => {
          calls.push(['profile', channelId, preference]);
          return { streamId: 102, codec: 'H.264', demuxer: 'h264', width: 1280, height: 720 };
        },
      },
      getRtspUrl: () => 'rtsp://example.invalid/Streaming/Channels/102',
    }),
    homey: {
      videos: { createVideoRTSP: async options => {
        calls.push(['video-options', options]);
        return video;
      } },
    },
    setCameraVideo: async () => { calls.push(['set-camera-video']); },
    registerCameraVideo: ChannelDevice.prototype.registerCameraVideo,
    recreateCameraVideo: ChannelDevice.prototype.recreateCameraVideo,
    error: error => { throw error; },
  };

  await ChannelDevice.prototype.onSettings.call(context, {
    newSettings,
    changedKeys: ['live_stream', 'video_transport'],
  });

  assert.deepEqual(calls.find(call => call[0] === 'profile'), ['profile', 1, 'substream']);
  assert.deepEqual(calls.find(call => call[0] === 'video-options'), [
    'video-options', { demuxer: 'h264', disableWebRTCProxy: true },
  ]);
  assert.equal(context.videoProfile.preference, 'substream');
  assert.equal(context.videoProfile.videoTransport, 'direct');
  assert.deepEqual(context.videoUrlRequests, {
    count: 0, lastRequestedAt: null, lastResult: null,
  });
  const urlListener = calls.find(call => call[0] === 'listener')[1];
  assert.deepEqual(await urlListener(), {
    url: 'rtsp://example.invalid/Streaming/Channels/102',
  });
  assert.equal(context.videoUrlRequests.count, 1);
  assert.equal(context.videoUrlRequests.lastResult, 'url-provided');
  assert.match(context.videoUrlRequests.lastRequestedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(JSON.stringify(context.videoUrlRequests), /example\.invalid/);
});

test('NVR-kanaaldiagnostiek bewaart geen RTSP-URL bij een aanvraagfout', async () => {
  let listener;
  const context = {
    channelId: 1,
    cameraVideoPromise: null,
    getSettings: () => ({ live_stream: 'substream', video_transport: 'direct' }),
    getName: () => 'Camera 1',
    requireParent: () => ({
      client: {
        getPreferredStreamingProfile: async () => ({
          streamId: 102, codec: 'H.264', demuxer: 'h264', width: 1280, height: 720,
        }),
      },
      getRtspUrl: () => { throw new Error('private RTSP URL failed'); },
    }),
    homey: {
      videos: { createVideoRTSP: async () => ({
        registerVideoUrlListener: callback => { listener = callback; },
      }) },
    },
    setCameraVideo: async () => {},
  };
  await ChannelDevice.prototype.registerCameraVideo.call(context);
  await assert.rejects(listener(), /private RTSP URL failed/);
  assert.equal(context.videoUrlRequests.count, 1);
  assert.equal(context.videoUrlRequests.lastResult, 'url-error');
  assert.doesNotMatch(JSON.stringify(context.videoUrlRequests), /private RTSP URL/);
});

test('beide widgets zoeken apparaten in hoofd- en kanaaldriver', () => {
  for (const widget of ['camera-zoom', 'recordings']) {
    const source = fs.readFileSync(path.join(root, 'widgets', widget, 'api.js'), 'utf8');
    assert.match(source, /'hikvision-camnvr', 'hikvision-nvr-channel'/);
  }
});
