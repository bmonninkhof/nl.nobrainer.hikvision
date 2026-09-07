'use strict';

const MAX_ITEMS = 16;
const MAX_SCHEMA_PATHS = 40;

const LOCAL_DISPLAY_PROBES = Object.freeze([
  {
    id: 'videoCapabilities',
    path: '/ISAPI/System/Video/capabilities',
    accept: 'application/xml',
  },
  {
    id: 'videoOutputs',
    path: '/ISAPI/System/Video/outputs/channels',
    accept: 'application/xml',
  },
  {
    id: 'videoMenus',
    path: '/ISAPI/System/Video/Menu',
    accept: 'application/xml',
  },
  {
    id: 'previewSplitSwitchConfig',
    path: '/ISAPI/System/Video/PreviewSplitSwitchCfg?format=json',
    accept: 'application/json, application/xml',
  },
]);

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function findValue(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  for (const value of Object.values(object)) {
    const result = findValue(value, key);
    if (result !== undefined) return result;
  }
  return undefined;
}

function optionalBoolean(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return null;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeScalar(value) {
  if (value === undefined || value === null || typeof value === 'object') return null;
  const scalar = String(value).trim();
  return scalar.length > 0 && scalar.length <= 80 ? scalar : null;
}

function collectSchemaPaths(value, prefix = '', result = []) {
  if (!value || typeof value !== 'object' || result.length >= MAX_SCHEMA_PATHS) return result;
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$' || result.length >= MAX_SCHEMA_PATHS) continue;
    const safeKey = String(key).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
    if (!safeKey) continue;
    const path = prefix ? `${prefix}.${safeKey}` : safeKey;
    if (!result.includes(path)) result.push(path);
    for (const item of asArray(entry)) collectSchemaPaths(item, path, result);
  }
  return result;
}

function summarizeVideoCapabilities(value) {
  return {
    videoOutputPortCount: optionalNumber(findValue(value, 'videoOutputPortNums')),
    menuCount: optionalNumber(findValue(value, 'menuNums')),
    previewSwitchSupported: optionalBoolean(findValue(value, 'isSupportPreviewSwitch')),
    previewSplitSwitchConfigSupported: optionalBoolean(findValue(value, 'isSupportPreviewSplitSwitchCfg')),
    menuStatusSupported: optionalBoolean(findValue(value, 'isSupportMenuStatus')),
    videoOutputModeSupported: optionalBoolean(findValue(value, 'isSupportVideoOutputMode')),
    viewTagSupported: optionalBoolean(findValue(value, 'isSupportViewTag')),
  };
}

function summarizeVideoOutputs(value) {
  return asArray(findValue(value, 'VideoOutputChannel')).slice(0, MAX_ITEMS).map(output => ({
    id: safeScalar(findValue(output, 'id')),
    type: safeScalar(findValue(output, 'type')),
    mode: safeScalar(findValue(output, 'mode')),
    resolution: safeScalar(findValue(output, 'resolution')),
    mirrorsMenu: optionalBoolean(findValue(output, 'mirrorMenu')),
  }));
}

function summarizeVideoMenus(value) {
  return asArray(findValue(value, 'Menu')).slice(0, MAX_ITEMS).map(menu => ({
    id: safeScalar(findValue(menu, 'id')),
    mode: safeScalar(findValue(menu, 'mode')),
    videoOutputPortIds: asArray(findValue(menu, 'videoOutputPortID'))
      .map(safeScalar)
      .filter(Boolean)
      .slice(0, MAX_ITEMS),
  }));
}

function summarizeLocalDisplayProbe(id, value, format) {
  if (id === 'videoCapabilities') return summarizeVideoCapabilities(value);
  if (id === 'videoOutputs') return summarizeVideoOutputs(value);
  if (id === 'videoMenus') return summarizeVideoMenus(value);
  if (id === 'previewSplitSwitchConfig') {
    return { format, schemaPaths: collectSchemaPaths(value) };
  }
  return null;
}

module.exports = { LOCAL_DISPLAY_PROBES, summarizeLocalDisplayProbe };
