'use strict';

const EVENT_CAPABILITIES = Object.freeze({
  VideoMotion: 'alarm_motion',
  VideoBlind: 'alarm_tamper',
  AlarmLocal: 'hik_alarm_local',
  VideoLoss: 'hik_alarm_video_loss',
  LineDetection: 'hik_alarm_line_crossing',
  IntrusionDetection: 'hik_alarm_intrusion',
  RegionEntranceDetection: 'hik_alarm_region_entrance',
  RegionExitingDetection: 'hik_alarm_region_exiting',
});
const MOTION_EVENT_CODES = Object.freeze([
  'VideoMotion',
  'LineDetection',
  'IntrusionDetection',
  'RegionEntranceDetection',
  'RegionExitingDetection',
]);
const SNAPSHOT_EVENT_CODES = Object.freeze([...MOTION_EVENT_CODES, 'Doorbell']);
const ALARM_CAPABILITIES = Object.freeze([...new Set(Object.values(EVENT_CAPABILITIES))]);

module.exports = {
  ALARM_CAPABILITIES,
  EVENT_CAPABILITIES,
  MOTION_EVENT_CODES,
  SNAPSHOT_EVENT_CODES,
};
