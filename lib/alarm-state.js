'use strict';

function updateAlarmState(activeChannels, action, channel) {
  const channelId = Number(channel);
  if (action === 'Start') activeChannels.add(channelId);
  if (action === 'Stop') activeChannels.delete(channelId);
  return activeChannels.size > 0;
}

function resetAlarmState(activeChannels) {
  activeChannels.clear();
  return false;
}

function isAnyAlarmActive(activeAlarmChannels, eventCodes) {
  return eventCodes.some(eventCode => (activeAlarmChannels.get(eventCode)?.size || 0) > 0);
}

function remainingAlarmHoldMs(startedAt, minimumSeconds, now = Date.now()) {
  if (!startedAt) return 0;
  return Math.max(0, startedAt + (Number(minimumSeconds) * 1000) - now);
}

module.exports = {
  isAnyAlarmActive,
  remainingAlarmHoldMs,
  resetAlarmState,
  updateAlarmState,
};
