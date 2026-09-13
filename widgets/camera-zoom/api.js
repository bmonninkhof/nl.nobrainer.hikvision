'use strict';

const ALLOWED_REFRESH_SECONDS = new Set([5, 10, 15, 30, 60]);
const DRIVER_IDS = ['hikvision-camnvr', 'hikvision-nvr-channel'];

function getDevice(homey, deviceId) {
  for (const driverId of DRIVER_IDS) {
    try {
      const device = homey.drivers.getDriver(driverId).getDevices()
        .find(candidate => candidate.getId() === String(deviceId || ''));
      if (device) return device;
    } catch {}
  }
  return undefined;
}

function getChannelId(body) {
  const channelId = Number(body?.channelId);
  return Number.isInteger(channelId) && channelId > 0 ? channelId : 1;
}

function getSnapshotMaxAgeMs(body) {
  const refreshSeconds = Number(body?.refreshSeconds);
  if (!ALLOWED_REFRESH_SECONDS.has(refreshSeconds)) return 14500;
  return Math.max(1000, (refreshSeconds * 1000) - 500);
}

module.exports = {
  async getChannels({ homey, body }) {
    const device = getDevice(homey, body?.deviceId);
    if (!device) throw new Error(homey.__('widget.camera_zoom.camera_missing'));
    return device.getRecordingChannels();
  },

  async getSnapshot({ homey, body }) {
    const deviceId = String(body?.deviceId || '');
    if (!deviceId) throw new Error(homey.__('widget.camera_zoom.no_camera_selected'));

    const device = getDevice(homey, deviceId);
    if (!device) throw new Error(homey.__('widget.camera_zoom.camera_missing'));

    return device.getWidgetSnapshot(getChannelId(body), { maxAgeMs: getSnapshotMaxAgeMs(body) });
  },

  async captureSnapshot({ homey, body }) {
    const deviceId = String(body?.deviceId || '');
    if (!deviceId) throw new Error(homey.__('widget.camera_zoom.no_camera_selected'));

    const device = getDevice(homey, deviceId);
    if (!device) throw new Error(homey.__('widget.camera_zoom.camera_missing'));

    return device.captureWidgetSnapshot(getChannelId(body));
  },
};
