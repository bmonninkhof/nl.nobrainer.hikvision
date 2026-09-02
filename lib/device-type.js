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

function supportsRtspOnlyFallback(deviceType) {
  const normalized = String(deviceType || '').replace(/[\s_-]+/g, '').toUpperCase();
  return normalized === 'UNKNOWN' || isVideoIntercomDevice(normalized);
}

module.exports = {
  isSingleChannelDevice,
  isVideoIntercomDevice,
  isVisDevice,
  supportsRtspOnlyFallback,
};
