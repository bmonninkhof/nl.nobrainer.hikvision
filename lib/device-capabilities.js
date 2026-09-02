'use strict';

const { isVisDevice } = require('./device-type');

const VIS_UNSUPPORTED_CAPABILITIES = Object.freeze([
  'hik_alarm_region_entrance',
  'hik_alarm_region_exiting',
]);

function getUnsupportedAlarmCapabilities(deviceType) {
  return isVisDevice(deviceType) ? [...VIS_UNSUPPORTED_CAPABILITIES] : [];
}

module.exports = { getUnsupportedAlarmCapabilities };
