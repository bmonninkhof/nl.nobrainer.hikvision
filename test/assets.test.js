'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function pngDimensions(file) {
  const data = fs.readFileSync(file);
  assert.equal(data.toString('ascii', 1, 4), 'PNG');
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

test('app- en drivericoon zijn verschillend en gebruiken een 960-pixelcanvas', () => {
  const appIcon = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.svg'), 'utf8');
  const driverIcon = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'hikvision-camnvr', 'assets', 'icon.svg'), 'utf8');
  assert.notEqual(driverIcon, appIcon);
  assert.match(appIcon, /viewBox="0 0 960 960"/);
  assert.match(driverIcon, /viewBox="0 0 960 960"/);
});

test('winkelafbeeldingen hebben alle verplichte afmetingen', () => {
  const root = path.join(__dirname, '..');
  assert.deepEqual(pngDimensions(path.join(root, 'assets/images/small.png')), [250, 175]);
  assert.deepEqual(pngDimensions(path.join(root, 'assets/images/large.png')), [500, 350]);
  assert.deepEqual(pngDimensions(path.join(root, 'assets/images/xlarge.png')), [1000, 700]);
  assert.deepEqual(pngDimensions(path.join(root, 'drivers/hikvision-camnvr/assets/images/small.png')), [75, 75]);
  assert.deepEqual(pngDimensions(path.join(root, 'drivers/hikvision-camnvr/assets/images/large.png')), [500, 500]);
  assert.deepEqual(pngDimensions(path.join(root, 'drivers/hikvision-camnvr/assets/images/xlarge.png')), [1000, 1000]);
});

test('Flow-kanaalomschrijvingen zijn geschikt voor camera, deurbel en NVR', () => {
  const flowRoot = path.join(__dirname, '..', '.homeycompose', 'flow');
  const flowFiles = fs.readdirSync(path.join(flowRoot, 'triggers'))
    .map(file => path.join(flowRoot, 'triggers', file))
    .concat(fs.readdirSync(path.join(flowRoot, 'actions'))
      .map(file => path.join(flowRoot, 'actions', file)))
    .concat(fs.readdirSync(path.join(flowRoot, 'conditions'))
      .map(file => path.join(flowRoot, 'conditions', file)));

  for (const file of flowFiles) {
    const contents = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(contents, /Camera number|Cameranummer|Kameranummer/);
  }
});
