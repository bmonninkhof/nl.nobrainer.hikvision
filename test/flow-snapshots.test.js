'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const flowRoot = path.join(__dirname, '..', '.homeycompose', 'flow');

test('visuele gebeurtenistriggers leveren een afbeeldingstag', () => {
  for (const id of ['VideoMotionStart', 'LineDetectionStart', 'IntrusionDetectionStart', 'RegionEntranceDetectionStart', 'RegionExitingDetectionStart', 'DoorbellPressed']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(flowRoot, 'triggers', `${id}.json`)));
    assert.deepEqual(manifest.tokens.map(token => [token.name, token.type]), [
      ['channelID', 'number'],
      ['snapshot', 'image'],
    ]);
  }
});

test('momentopnameactie kiest apparaat en kanaal en levert een afbeelding', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(flowRoot, 'actions', 'take_snapshot.json')));
  assert.deepEqual(manifest.tokens.map(token => [token.name, token.type]), [['snapshot', 'image']]);
  assert.equal(manifest.args.find(argument => argument.name === 'channel').type, 'autocomplete');
  assert.equal(manifest.args.find(argument => argument.name === 'device').type, 'device');
});
