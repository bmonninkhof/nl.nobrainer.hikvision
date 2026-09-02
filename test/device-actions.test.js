'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const homeyPath = require.resolve('homey');

require.cache[homeyPath] = {
  id: homeyPath,
  filename: homeyPath,
  loaded: true,
  exports: { Device: class {} },
};
const HikvisionDevice = require('../drivers/hikvision-camnvr/device');

const methods = HikvisionDevice.prototype;

function translate(key) {
  return key;
}

test('deurrelais valideert het nummer en gebruikt de actieve client', async () => {
  const calls = [];
  const device = {
    client: { triggerRelay: async relay => { calls.push(relay); return true; } },
    isapiAvailable: true,
    homey: { __: translate },
    doorRelays: new Set([1]),
    lastRelayCommandAt: 0,
    relayDiagnostics: [],
    recordRelayAttempt: methods.recordRelayAttempt,
  };

  assert.equal(await methods.triggerRelay.call(device, 1), true);
  assert.deepEqual(calls, [1]);
  await assert.rejects(methods.triggerRelay.call(device, 0), /errors.invalid_relay/);
});

test('PTZ-preset geeft NVR-kanaal en preset door aan de client', async () => {
  let request;
  const device = {
    client: {
      getPtzPresets: async () => new Map([[12, 'Gate']]),
      gotoPtzPreset: async value => { request = value; return true; },
    },
    isapiAvailable: true,
    homey: { __: translate },
    getCapabilityValue: () => 'NVR',
    ptzChannels: new Set([4]),
  };

  assert.equal(await methods.gotoPtzPreset.call(device, 4, 12), true);
  assert.deepEqual(request, { channel: 4, preset: 12, isNvr: true });
  await assert.rejects(methods.gotoPtzPreset.call(device, 4, 0), /errors.invalid_preset/);
});

test('gebeurtenisbewaking kan worden uitgeschakeld zonder Live-video te stoppen', async () => {
  let alertStreamStopped = false;
  let alarmsReset = false;
  let storedValue;
  const triggers = [];
  const device = {
    client: { stopAlertStream: () => { alertStreamStopped = true; } },
    eventMonitoringEnabled: true,
    callStatusPollTimer: null,
    callStatusDiagnostics: { polling: true, detection: 'capabilities' },
    setStoreValue: async (_key, value) => { storedValue = value; },
    setCapabilityValue: async () => {},
    resetAlarmCapabilities: async () => { alarmsReset = true; },
    driver: { trigger: async id => { triggers.push(id); } },
  };

  assert.equal(await methods.setEventMonitoring.call(device, false), true);
  assert.equal(device.eventMonitoringEnabled, false);
  assert.equal(storedValue, false);
  assert.equal(alertStreamStopped, true);
  assert.equal(alarmsReset, true);
  assert.equal(device.callStatusDiagnostics.polling, false);
  assert.deepEqual(triggers, ['EventMonitoringDisabled']);
});

test('gebeurtenisbewaking hervat alertstream en deurbelcontrole', async () => {
  let alertStreamStarted = false;
  let pollingArgs;
  const triggers = [];
  const client = { startAlertStream: () => { alertStreamStarted = true; } };
  const device = {
    client,
    isapiAvailable: true,
    eventMonitoringEnabled: false,
    connectionGeneration: 7,
    homey: { __: translate },
    setStoreValue: async () => {},
    setCapabilityValue: async () => {},
    getCapabilityValue: () => 'VIS',
    configureCallStatusPolling: async (...args) => { pollingArgs = args; },
    driver: { trigger: async id => { triggers.push(id); } },
  };

  assert.equal(await methods.setEventMonitoring.call(device, true), true);
  assert.equal(alertStreamStarted, true);
  assert.deepEqual(pollingArgs, ['VIS', client, 7]);
  assert.deepEqual(triggers, ['EventMonitoringEnabled']);
});

test('deurrelais blokkeert snelle herhaling en registreert beide resultaten', async () => {
  const device = {
    client: { triggerRelay: async () => true },
    isapiAvailable: true,
    homey: { __: translate },
    doorRelays: new Set([1]),
    lastRelayCommandAt: 0,
    relayDiagnostics: [],
    recordRelayAttempt: methods.recordRelayAttempt,
  };

  assert.equal(await methods.triggerRelay.call(device, 1), true);
  await assert.rejects(methods.triggerRelay.call(device, 1), /errors.relay_cooldown/);
  assert.deepEqual(device.relayDiagnostics.map(entry => entry.result), ['success', 'blocked-cooldown']);
  assert.equal(device.relayDiagnostics.every(entry => entry.timestamp && entry.relay === 1), true);
});

test('autocomplete toont alleen gedetecteerde kanalen, relais en presets', async () => {
  const device = {
    availableChannels: new Map([[1, 'Front'], [2, 'Garden']]),
    ptzChannels: new Set([2]),
    doorRelays: new Set([1, 2]),
    client: { getPtzPresets: async () => new Map([[5, 'Gate'], [6, 'Patio']]) },
    homey: { __: (_key, tokens) => `Relay ${tokens.relay}` },
    getCapabilityValue: () => 'NVR',
    filterAutocompleteOptions: methods.filterAutocompleteOptions,
  };

  assert.deepEqual(methods.getChannelOptions.call(device, '', { ptzOnly: true }), [
    { id: 2, name: '[2] Garden' },
  ]);
  assert.deepEqual(methods.getRelayOptions.call(device, '2'), [{ id: 2, name: 'Relay 2' }]);
  assert.deepEqual(await methods.getPtzPresetOptions.call(device, 2, 'gate'), [
    { id: 5, name: '[5] Gate' },
  ]);
});

test('snapshotcache verwijdert oudste kanalen boven het geheugenbudget', () => {
  const device = {
    snapshotCache: new Map(),
    snapshotCacheUpdatedAt: new Map(),
    snapshotRetryAfter: new Map(),
  };
  const tenMegabytes = Buffer.alloc(10 * 1024 * 1024);

  methods.cacheSnapshot.call(device, 1, tenMegabytes);
  methods.cacheSnapshot.call(device, 2, tenMegabytes);
  methods.cacheSnapshot.call(device, 3, tenMegabytes);

  assert.deepEqual([...device.snapshotCache.keys()], [2, 3]);
  assert.equal([...device.snapshotCache.values()].reduce((sum, value) => sum + value.length, 0), 20 * 1024 * 1024);
});

test('Flow-snapshots zijn begrensd en oudste afbeeldingen worden opgeruimd', async () => {
  const images = [];
  const device = {
    client: {},
    homey: {
      __: translate,
      images: {
        createImage: async () => {
          const image = {
            unregistered: false,
            setStream: listener => { image.listener = listener; },
            unregister: async () => { image.unregistered = true; },
          };
          images.push(image);
          return image;
        },
      },
    },
    error: () => {},
    flowSnapshotImages: new Set(),
    flowSnapshotCleanupTimers: new Map(),
    getSnapshotBuffer: async () => Buffer.from('jpeg'),
    availableChannels: new Map([[1, 'Camera']]),
    unregisterFlowSnapshot: methods.unregisterFlowSnapshot,
  };

  for (let index = 0; index < 9; index += 1) {
    await methods.createFlowSnapshot.call(device, 1);
  }

  assert.equal(device.flowSnapshotImages.size, 8);
  assert.equal(images[0].unregistered, true);
  for (const image of [...device.flowSnapshotImages]) {
    await methods.unregisterFlowSnapshot.call(device, image);
  }
});

test('een nieuwe PTZ-opdracht vervangt de lopende timer voor hetzelfde kanaal', async () => {
  const commands = [];
  const device = {
    client: { movePtz: async command => { commands.push(command); return true; } },
    homey: { __: translate },
    getCapabilityValue: () => 'CAMERA',
    ptzOperations: new Map(),
    ptzDelayTimers: new Map(),
    ptzChannels: new Set([1]),
    cancelPtzDelay: methods.cancelPtzDelay,
  };

  const first = methods.movePtz.call(device, {
    pan: 10, tilt: 0, zoom: 0, channel: 1, duration: 10,
  });
  await new Promise(resolve => setImmediate(resolve));
  const second = methods.movePtz.call(device, {
    pan: 20, tilt: 0, zoom: 0, channel: 1, duration: 0.1,
  });
  await first;

  assert.equal(device.ptzDelayTimers.size, 1);
  await second;
  assert.equal(device.ptzDelayTimers.size, 0);
  assert.deepEqual(commands.map(command => command.pan), [10, 20, 0]);
});
