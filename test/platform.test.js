import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dataHome, chromiumTarget } from '../src/platform.js';

test('Windows data uses LocalAppData, including paths with spaces', () => {
  assert.equal(dataHome('win32', { LOCALAPPDATA: 'C:\\Users\\Jane Doe\\AppData\\Local' }), 'C:\\Users\\Jane Doe\\AppData\\Local\\Marlin');
  assert.equal(dataHome('win32', {}, 'C:\\Users\\Jane'), 'C:\\Users\\Jane\\AppData\\Local\\Marlin');
  assert.equal(dataHome('win32', { MARLIN_HOME: 'D:\\Marlin test' }), 'D:\\Marlin test');
});
test('existing macOS data path is preserved', () => {
  assert.match(dataHome('darwin', {}, '/Users/test'), /Library[\\/]Application Support[\\/]Marlin$/);
});
test('Chromium layout follows the requested OS and architecture', () => {
  assert.deepEqual(chromiumTarget('win32', 'x64').executable, ['chrome-win', 'chrome.exe']);
  assert.equal(chromiumTarget('darwin', 'arm64').bucket, 'Mac_Arm');
  assert.equal(chromiumTarget('darwin', 'x64').bucket, 'Mac');
  assert.throws(() => chromiumTarget('win32', 'arm64'), /not supported/);
  assert.throws(() => chromiumTarget('linux', 'x64'), /MARLIN_CHROMIUM/);
});
