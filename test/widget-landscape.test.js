'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const widget = fs.readFileSync(path.join(root, 'widgets/camera-zoom/public/index.html'), 'utf8');

test('camera widget offers an accessible landscape fullscreen control', () => {
  assert.match(widget, /id="landscape"[^>]+aria-pressed="false"/);
  assert.match(widget, /cameraCard\.requestFullscreen/);
  assert.match(widget, /cameraCard\.webkitRequestFullscreen/);
  assert.match(widget, /window\.screen\.orientation\.lock\('landscape'\)/);
  assert.doesNotMatch(widget, /Homey\.setHeight\('177\.78%'\)/);
  assert.doesNotMatch(widget, /landscape-fallback/);
  assert.match(widget, /document\.addEventListener\('fullscreenchange'/);
  assert.match(widget, /document\.addEventListener\('webkitfullscreenchange'/);
});

test('landscape labels are translated in every supported language', () => {
  for (const language of ['en', 'nl', 'de']) {
    const locale = JSON.parse(fs.readFileSync(path.join(root, 'locales', `${language}.json`)));
    const translations = locale.widget.camera_zoom;
    for (const key of ['enter_landscape', 'exit_landscape', 'rotate_phone', 'landscape_unavailable']) {
      assert.equal(typeof translations[key], 'string', `${language}.${key} should be translated`);
      assert.ok(translations[key].length > 0, `${language}.${key} should not be empty`);
    }
  }
});
