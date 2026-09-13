'use strict';

const Homey = require('homey');
const { createMinimalBugReport } = require('../../lib/minimal-bug-report');
const { getDiagnosticErrorCode } = require('../../lib/hikvision-client');

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

class HikvisionNvrChannelDriver extends Homey.Driver {
  async onInit() {
    this.triggers = Object.fromEntries(TRIGGER_IDS.map(id => [
      id,
      this.homey.flow.getDeviceTriggerCard(id),
    ]));
    this.log('Hikvision NVR channel driver initialized');
  }

  getParentDevices() {
    try {
      return this.homey.drivers.getDriver('hikvision-camnvr').getDevices()
        .filter(device => String(device.getCapabilityValue('hik_type') || '').toUpperCase().includes('NVR'));
    } catch (error) {
      this.error('Could not read installed Hikvision NVR devices', error);
      return [];
    }
  }

  findParentDevice(parentId) {
    return this.getParentDevices().find(device => String(device.getData()?.id || '') === String(parentId || ''));
  }

  async onPair(session) {
    session.setHandler('list_devices', async () => {
      const existing = new Set(this.getDevices().map(device => {
        const data = device.getData();
        return `${data.parentId}:${Number(data.channel)}`;
      }));
      const candidates = [];
      for (const parent of this.getParentDevices()) {
        const parentId = String(parent.getData()?.id || '');
        for (const channel of parent.getRecordingChannels()) {
          const channelId = Number(channel.id);
          if (!Number.isInteger(channelId) || channelId < 1) continue;
          const key = `${parentId}:${channelId}`;
          if (existing.has(key)) continue;
          candidates.push({
            name: `${parent.getName()} – ${channel.name}`,
            data: {
              id: key,
              parentId,
              channel: channelId,
            },
            settings: {
              live_stream: 'automatic',
              video_transport: 'automatic',
              motion_hold_seconds: Number(parent.getSettings().motion_hold_seconds) || 10,
            },
            iconOverride: 'camera',
          });
        }
      }
      return candidates;
    });
  }

  async onRepair(session, device) {
    session.setHandler('showView', async () => true);
    session.setHandler('get_bug_report', async () => {
      try {
        return await device.getBugReport();
      } catch (error) {
        let manifest = {};
        try { manifest = this.homey.app?.manifest || this.homey.manifest || {}; } catch {}
        return createMinimalBugReport(manifest, getDiagnosticErrorCode(error));
      }
    });
  }

  async trigger(id, device, tokens = {}) {
    const card = this.triggers[id];
    if (!card) return;
    try {
      await card.trigger(device, tokens);
    } catch (error) {
      this.error(`NVR channel Flow trigger ${id} failed`, error);
    }
  }
}

module.exports = HikvisionNvrChannelDriver;
