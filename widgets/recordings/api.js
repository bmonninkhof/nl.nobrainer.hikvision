'use strict';

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

module.exports = {
  async getChannels({ homey, body }) {
    const device = getDevice(homey, body?.deviceId);
    if (!device) throw new Error(homey.__('widget.camera_zoom.camera_missing'));
    return device.getRecordingChannels();
  },
  async search({ homey, body }) {
    const device = getDevice(homey, body?.deviceId);
    if (!device) throw new Error(homey.__('widget.camera_zoom.camera_missing'));
    return device.searchWidgetRecordings(body);
  },
  async select({ homey, body }) {
    const device = getDevice(homey, body?.deviceId);
    if (!device) throw new Error(homey.__('widget.camera_zoom.camera_missing'));
    return device.selectWidgetRecording(body?.token);
  },
};
