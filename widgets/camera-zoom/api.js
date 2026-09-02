'use strict';

module.exports = {
  async getSnapshot({ homey, body }) {
    const deviceId = String(body?.deviceId || '');
    if (!deviceId) throw new Error(homey.__('widget.camera_zoom.no_camera_selected'));

    const driver = homey.drivers.getDriver('hikvision-camnvr');
    const device = driver.getDevices().find(candidate => candidate.getId() === deviceId);
    if (!device) throw new Error(homey.__('widget.camera_zoom.camera_missing'));

    return device.getWidgetSnapshot(1);
  },
};
