'use strict';

const Homey = require('homey');
const { HikvisionClient, getDiagnosticErrorCode } = require('../../lib/hikvision-client');
const { getDeviceIconType, isSingleChannelDevice } = require('../../lib/device-type');
const { createMinimalBugReport } = require('../../lib/minimal-bug-report');
const { normalizeAuthMethod, parseBoolean } = require('../../lib/settings');
const { getUserErrorMessage } = require('../../lib/user-error');

const TRIGGER_IDS = [
  'OnConnected',
  'OnDisconnected',
  'OnError',
  'VideoMotionStart',
  'VideoMotionStop',
  'AlarmLocalStart',
  'AlarmLocalStop',
  'VideoLossStart',
  'VideoLossStop',
  'VideoBlindStart',
  'VideoBlindStop',
  'LineDetectionStart',
  'LineDetectionStop',
  'IntrusionDetectionStart',
  'IntrusionDetectionStop',
  'RegionEntranceDetectionStart',
  'RegionEntranceDetectionStop',
  'RegionExitingDetectionStart',
  'RegionExitingDetectionStop',
  'DoorbellPressed',
  'SnapshotCaptured',
  'EventMonitoringEnabled',
  'EventMonitoringDisabled',
];
const CONDITION_CAPABILITIES = {
  hik_status_is_connected: 'hik_status',
  hik_alarm_local_is_active: 'hik_alarm_local',
  hik_alarm_video_loss_is_active: 'hik_alarm_video_loss',
  hik_alarm_line_crossing_is_active: 'hik_alarm_line_crossing',
  hik_alarm_intrusion_is_active: 'hik_alarm_intrusion',
  hik_alarm_region_entrance_is_active: 'hik_alarm_region_entrance',
  hik_alarm_region_exiting_is_active: 'hik_alarm_region_exiting',
  hik_event_monitoring_is_active: 'hik_event_monitoring',
};
const HOMEY_ICON_OVERRIDES = Object.freeze({
  camera: 'camera',
  doorbell: 'doorbell2',
  ptz: 'sensor-outdoor-motion',
  recorder: 'vcr',
});
const DISCOVERY_STRATEGY_IDS = ['hikvision-mac', 'hikvision-mac-2', 'hikvision-mac-3'];

function selectedNumber(value) {
  return Number(value?.id ?? value);
}

class HikvisionDriver extends Homey.Driver {
  async onInit() {
    this.triggers = Object.fromEntries(TRIGGER_IDS.map(id => [
      id,
      this.homey.flow.getDeviceTriggerCard(id),
    ]));

    for (const [id, capability] of Object.entries(CONDITION_CAPABILITIES)) {
      this.homey.flow.getConditionCard(id).registerRunListener(({ device }) => {
        if (!device) throw new Error(this.homey.__('errors.device_missing'));
        return Boolean(device.getCapabilityValue(capability));
      });
    }

    const registerAutocomplete = (card, argument, listener) => {
      card.registerArgumentAutocompleteListener(argument, async (query, args) => {
        if (!args.device) return [];
        try {
          return await listener(query, args);
        } catch (error) {
          this.error(`Autocomplete voor ${argument} is mislukt`, error);
          return [];
        }
      });
    };

    const ptzContinuousCard = this.homey.flow.getActionCard('ptzcontinuous');
    ptzContinuousCard.registerRunListener(async args => {
      if (!args.device) throw new Error(this.homey.__('errors.device_missing'));
      return args.device.movePtz({
        pan: args.pannumber,
        tilt: args.tiltnumber,
        zoom: args.zoomnumber,
        channel: selectedNumber(args.channel),
        duration: args.duration,
      });
    });
    registerAutocomplete(ptzContinuousCard, 'channel', (query, args) => (
      args.device.getChannelOptions(query, { ptzOnly: true })
    ));

    const ptzStopCard = this.homey.flow.getActionCard('ptzstop');
    ptzStopCard.registerRunListener(async args => {
      if (!args.device) throw new Error(this.homey.__('errors.device_missing'));
      return args.device.stopPtz(selectedNumber(args.channel));
    });
    registerAutocomplete(ptzStopCard, 'channel', (query, args) => (
      args.device.getChannelOptions(query, { ptzOnly: true })
    ));

    const ptzPresetCard = this.homey.flow.getActionCard('ptz_preset');
    ptzPresetCard.registerRunListener(async args => {
      if (!args.device) throw new Error(this.homey.__('errors.device_missing'));
      return args.device.gotoPtzPreset(selectedNumber(args.channel), selectedNumber(args.preset));
    });
    registerAutocomplete(ptzPresetCard, 'channel', (query, args) => (
      args.device.getChannelOptions(query, { ptzOnly: true })
    ));
    registerAutocomplete(ptzPresetCard, 'preset', (query, args) => (
      args.device.getPtzPresetOptions(args.channel, query)
    ));

    const relayCard = this.homey.flow.getActionCard('trigger_relay');
    relayCard.registerRunListener(async args => {
      if (!args.device) throw new Error(this.homey.__('errors.device_missing'));
      return args.device.triggerRelay(selectedNumber(args.relay));
    });
    registerAutocomplete(relayCard, 'relay', (query, args) => args.device.getRelayOptions(query));
    this.homey.flow.getActionCard('end_intercom_call').registerRunListener(async args => {
      if (!args.device) throw new Error(this.homey.__('errors.device_missing'));
      return args.device.endIntercomCall();
    });
    this.homey.flow.getActionCard('enable_event_monitoring').registerRunListener(async args => {
      if (!args.device) throw new Error(this.homey.__('errors.device_missing'));
      return args.device.setEventMonitoring(true);
    });
    this.homey.flow.getActionCard('disable_event_monitoring').registerRunListener(async args => {
      if (!args.device) throw new Error(this.homey.__('errors.device_missing'));
      return args.device.setEventMonitoring(false);
    });
    const snapshotCard = this.homey.flow.getActionCard('take_snapshot');
    snapshotCard.registerRunListener(async args => {
      if (!args.device) throw new Error(this.homey.__('errors.device_missing'));
      return {
        snapshot: await args.device.createFlowSnapshot(selectedNumber(args.channel)),
      };
    });
    registerAutocomplete(snapshotCard, 'channel', (query, args) => args.device.getChannelOptions(query));
    this.log('Hikvision driver initialized');
  }

  async onPair(session) {
    let pairingDevice = null;
    let pairingData = null;
    let pairingDataRevision = 0;

    session.setHandler('getDiscoveredDevices', async () => this.getDiscoveredDevices());
    session.setHandler('getPairingData', async () => ({
      data: pairingData,
      revision: pairingDataRevision,
    }));
    session.setHandler('updatePairingData', async payload => {
      const revision = Number(payload?.revision) || 0;
      if (revision >= pairingDataRevision) {
        pairingDataRevision = revision;
        pairingData = payload?.data || null;
        pairingDevice = null;
      }
      return true;
    });
    session.setHandler('runPairingTest', async () => {
      pairingDevice = null;
      if (!pairingData) throw new Error(this.homey.__('pair.nosettings'));
      const testedDevice = await this.testConnection(pairingData);
      pairingDevice = this.createPairingDevice(testedDevice, pairingData.icon_type);
      return {
        id: testedDevice.id,
        name: testedDevice.name,
        type: testedDevice.type,
        firmwareVersion: testedDevice.firmwareVersion,
        snapshotAvailable: testedDevice.snapshotAvailable,
        snapshotBytes: testedDevice.snapshotBytes,
        snapshotChannel: testedDevice.snapshotChannel,
        iconType: pairingDevice.iconOverride,
      };
    });
    session.setHandler('list_devices', async () => {
      if (!pairingDevice) throw new Error(this.homey.__('pair.test_required'));
      return [pairingDevice];
    });
    session.setHandler('disconnect', async () => {
      pairingDevice = null;
      pairingData = null;
    });
  }

  getDiscoveredDevices() {
    try {
      const addresses = DISCOVERY_STRATEGY_IDS.flatMap(id => {
        const strategy = this.homey.discovery.getStrategy(id);
        return Object.values(strategy.getDiscoveryResults());
      })
        .map(result => String(result.address || '').trim())
        .filter(Boolean);
      return [...new Set(addresses)]
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .map(address => ({ address }));
    } catch (error) {
      this.error('Automatische Hikvision-detectie is mislukt', error);
      return [];
    }
  }

  createPairingDevice(testedDevice, requestedIconType) {
    let automaticIconType = getDeviceIconType(testedDevice.type);
    if (automaticIconType === 'camera' && testedDevice.ptzAvailable) automaticIconType = 'ptz';
    const iconType = Object.hasOwn(HOMEY_ICON_OVERRIDES, requestedIconType)
      ? requestedIconType
      : automaticIconType;
    return {
      name: testedDevice.name,
      data: { id: testedDevice.id },
      settings: testedDevice.settings,
      iconOverride: HOMEY_ICON_OVERRIDES[iconType],
    };
  }

  async onRepair(session, device) {
    let bugReportPromise = null;
    const getBugReport = async () => {
      if (bugReportPromise) return bugReportPromise;
      bugReportPromise = (async () => {
        try {
          if (typeof device.getBugReport === 'function') return await device.getBugReport();
          return { success: false, error: this.homey.__('repair.unavailable') };
        } catch (error) {
          this.error('Bug report generation failed', error);
          return createMinimalBugReport(this.homey.manifest, getDiagnosticErrorCode(error));
        } finally {
          bugReportPromise = null;
        }
      })();
      return bugReportPromise;
    };
    session.setHandler('showView', async () => true);
    session.setHandler('get_bug_report', getBugReport);
  }

  normalizeSettings(data) {
    return {
      address: String(data.address || '').trim(),
      username: String(data.username || '').trim(),
      password: String(data.password || ''),
      auth_method: normalizeAuthMethod(data.auth_method),
      port: Number(data.port),
      rtsp_port: Number(data.rtsp_port) || 554,
      ssl: parseBoolean(data.ssl),
      strict: parseBoolean(data.strict),
      motion_hold_seconds: Number(data.motion_hold_seconds) || 10,
    };
  }

  async testConnection(data) {
    const settings = this.normalizeSettings(data);
    if (!settings.address || !settings.username || !settings.port || !settings.rtsp_port) {
      throw new Error(this.homey.__('pair.nosettings'));
    }
    const client = new HikvisionClient({
      host: settings.address,
      port: settings.port,
      ssl: settings.ssl,
      strict: settings.strict,
      username: settings.username,
      password: settings.password,
      authMethod: settings.auth_method,
      translate: (key, tokens) => this.homey.__(key, tokens),
    });
    try {
      const info = await client.getDeviceInfo();
      const existingDevice = this.getDevices().find(device => String(device.getData().id) === info.id);
      if (existingDevice) {
        const error = new Error(this.homey.__('pair.already_added', { name: existingDevice.getName() }));
        error.code = 'DUPLICATE_DEVICE';
        throw error;
      }
      const type = String(info.type || '');
      const channels = isSingleChannelDevice(type) || !type.toUpperCase().includes('NVR')
        ? new Map([[1, 'Camera']])
        : await client.getChannels();
      let ptzAvailable = false;
      if (getDeviceIconType(type) === 'camera') {
        const ptzChannels = await client.getPtzChannels({
          channelIds: [...channels.keys()],
          isNvr: false,
        });
        ptzAvailable = ptzChannels.size > 0;
      }
      const snapshotChannel = channels.keys().next().value || 1;
      let snapshotBytes = 0;
      let snapshotAvailable = false;
      try {
        const snapshot = await client.getSnapshot(snapshotChannel);
        snapshotAvailable = snapshot.length >= 4 && snapshot[0] === 0xff && snapshot[1] === 0xd8;
        snapshotBytes = snapshot.length;
      } catch (error) {
        this.log(`Snapshot is niet beschikbaar tijdens koppelen: ${error.message}`);
      }
      return {
        ...info,
        settings,
        snapshotAvailable,
        snapshotBytes,
        snapshotChannel,
        ptzAvailable,
      };
    } catch (error) {
      if (error.code === 'DUPLICATE_DEVICE') throw error;
      this.error('Connection test failed', error);
      throw new Error(getUserErrorMessage(error, key => this.homey.__(key)));
    } finally {
      client.stop();
    }
  }

  async trigger(id, device, tokens = {}) {
    const card = this.triggers[id];
    if (!card) return;
    try {
      await card.trigger(device, tokens);
    } catch (error) {
      this.error(`Flow-trigger ${id} is mislukt`, error);
    }
  }
}

module.exports = HikvisionDriver;
