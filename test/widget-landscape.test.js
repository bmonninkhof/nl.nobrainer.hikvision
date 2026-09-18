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
  assert.match(widget, /fullscreenAvailable = getFullscreenElement\(\) === cameraCard/);
  assert.match(widget, /window\.screen\.orientation\.lock\('landscape'\)/);
  assert.match(widget, /Homey\.setHeight\('177\.78%'\)/);
  assert.match(widget, /landscapeFallback = true/);
  assert.match(widget, /body\.landscape-fallback \.camera-card/);
  assert.match(widget, /id="fallback-exit"[^>]+class="fallback-exit"/);
  assert.match(widget, /body\.landscape-fallback \.fallback-exit \{ display: grid;/);
  assert.match(widget, /fallbackExitButton\.addEventListener\('click',[\s\S]*?await exitLandscape\(\)/);
  assert.match(widget, /window\.matchMedia\?\.\('\(orientation: landscape\)'\)\.matches/);
  assert.match(widget, /if \(fullscreenAvailable\) \{\s*try \{\s*if \(window\.screen\.orientation\?\.lock\)/);
  assert.doesNotMatch(widget, /showLandscapeHint\(text\('rotate_phone'/);
  assert.match(widget, /document\.addEventListener\('fullscreenchange'/);
  assert.match(widget, /document\.addEventListener\('webkitfullscreenchange'/);
});

test('rotated camera widget keeps touch panning inside the image', () => {
  assert.match(widget, /const viewportWidth = viewport\.clientWidth/);
  assert.match(widget, /if \(landscapeFallback\) \{\s*panX \+= deltaY;\s*panY -= deltaX;/);
  assert.match(widget, /addEventListener\('touchmove',[\s\S]*?passive: false/);
  assert.match(widget, /overscroll-behavior: none/);
});

test('camera button captures a snapshot through the Flow endpoint', () => {
  assert.match(widget, /const endpoint = manual \? '\/capture' : '\/snapshot'/);
  assert.match(widget, /text\('capture', 'Take snapshot'\)/);
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
