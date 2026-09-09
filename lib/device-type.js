'use strict';

function isSingleChannelDevice(deviceType) {
  const normalized = String(deviceType || '').replace(/[\s_-]+/g, '').toUpperCase();
  return normalized === 'VIS'
    || normalized.includes('IPCAMERA')
    || normalized.includes('DOORBELL')
    || normalized.includes('DOORSTATION')
    || normalized.includes('VIDEOINTERCOM');
}

function isVideoIntercomDevice(deviceType) {
  const normalized = String(deviceType || '').replace(/[\s_-]+/g, '').toUpperCase();
  return normalized === 'VIS'
    || normalized.includes('DOORBELL')
    || normalized.includes('DOORSTATION')
    || normalized.includes('VIDEOINTERCOM');
}

function isVisDevice(deviceType) {
  return String(deviceType || '').replace(/[\s_-]+/g, '').toUpperCase() === 'VIS';
}

function getDeviceIconType(deviceType) {
  const normalized = String(deviceType || '').replace(/[\s_-]+/g, '').toUpperCase();
  if (normalized.includes('NVR') || normalized.includes('DVR') || normalized.includes('RECORDER')) {
    return 'recorder';
  }
  if (isVideoIntercomDevice(normalized)) return 'doorbell';
  return 'camera';
}

function supportsRtspOnlyFallback(deviceType) {
  const normalized = String(deviceType || '').replace(/[\s_-]+/g, '').toUpperCase();
  return normalized === 'UNKNOWN' || isVideoIntercomDevice(normalized);
}

module.exports = {
  isSingleChannelDevice,
  isVideoIntercomDevice,
  isVisDevice,
  getDeviceIconType,
  supportsRtspOnlyFallback,
};
