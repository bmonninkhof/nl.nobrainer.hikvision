'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isAnyAlarmActive,
  remainingAlarmHoldMs,
  resetAlarmState,
  updateAlarmState,
} = require('../lib/alarm-state');

test('alarmstatus blijft actief zolang een NVR-kanaal dezelfde gebeurtenis meldt', () => {
  const activeChannels = new Set();

  assert.equal(updateAlarmState(activeChannels, 'Start', 1), true);
  assert.equal(updateAlarmState(activeChannels, 'Start', 2), true);
  assert.equal(updateAlarmState(activeChannels, 'Stop', 1), true);
  assert.equal(updateAlarmState(activeChannels, 'Stop', 2), false);
  assert.deepEqual([...activeChannels], []);
});

test('onbekende acties veranderen de alarmstatus niet', () => {
  const activeChannels = new Set([3]);

  assert.equal(updateAlarmState(activeChannels, 'Update', 3), true);
  assert.deepEqual([...activeChannels], [3]);
});

test('reset wist alle actieve alarmkanalen', () => {
  const activeChannels = new Set([1, 2, 3]);

  assert.equal(resetAlarmState(activeChannels), false);
  assert.equal(activeChannels.size, 0);
});

test('Homey-bewegingsstatus omvat beweging, lijnoverschrijding en indringing', () => {
  const activeAlarmChannels = new Map([
    ['VideoMotion', new Set()],
    ['LineDetection', new Set()],
    ['IntrusionDetection', new Set([2])],
    ['RegionEntranceDetection', new Set()],
    ['RegionExitingDetection', new Set()],
  ]);
  const motionEventCodes = ['VideoMotion', 'LineDetection', 'IntrusionDetection', 'RegionEntranceDetection', 'RegionExitingDetection'];

  assert.equal(isAnyAlarmActive(activeAlarmChannels, motionEventCodes), true);
  activeAlarmChannels.get('IntrusionDetection').clear();
  assert.equal(isAnyAlarmActive(activeAlarmChannels, motionEventCodes), false);
  activeAlarmChannels.get('LineDetection').add(4);
  assert.equal(isAnyAlarmActive(activeAlarmChannels, motionEventCodes), true);
});

test('korte detectiepuls houdt de Homey-bewegingsstatus minimaal actief', () => {
  const startedAt = 1_000;

  assert.equal(remainingAlarmHoldMs(startedAt, 10, 3_000), 8_000);
  assert.equal(remainingAlarmHoldMs(startedAt, 10, 11_000), 0);
  assert.equal(remainingAlarmHoldMs(0, 10, 3_000), 0);
});
