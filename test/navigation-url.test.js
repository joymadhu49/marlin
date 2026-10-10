import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
mock.module('../src/paths.js', { namedExports: {
  paths: {}, chromiumPath() {}, readJson: () => [], writeJson() {},
} });
const { MarlinBrowser } = await import('../src/browser.js');
for (const [input, expected] of [
  ['localhost:3000/app', 'http://localhost:3000/app'],
  ['devbox:8080', 'http://devbox:8080'],
  ['127.0.0.1:3000', 'http://127.0.0.1:3000'],
  ['[::1]:3000/app', 'http://[::1]:3000/app'],
  ['[2001:db8::1]:8443/app', 'https://[2001:db8::1]:8443/app'],
  ['example.com:8443/path', 'https://example.com:8443/path'],
  ['example.com', 'https://example.com'],
  ['https://example.com:8443', 'https://example.com:8443'],
  ['about:blank', 'about:blank'],
  ['data:text/plain,hello', 'data:text/plain,hello'],
  ['data:123', 'data:123'],
  ['about:123', 'about:123'],
  ['tel:123', 'tel:123'],
  ['find my page', 'https://duckduckgo.com/?q=find%20my%20page'],
]) {
  test(`navigation normalizes ${input}`, async () => {
    let destination;
    const page = { goto: async (url) => { destination = url; }, waitForNetworkIdle: async () => {} };
    await new MarlinBrowser({}).goto(page, input);
    assert.equal(destination, expected);
  });
}
