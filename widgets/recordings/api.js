'use strict';

function getDevice(homey, deviceId) {
  const driver = homey.drivers.getDriver('hikvision-camnvr');
  return driver.getDevices().find(device => device.getId() === String(deviceId || ''));
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
