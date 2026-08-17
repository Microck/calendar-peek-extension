'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, 'Calendar Peek');
assert.equal(manifest.version, '0.2.1');
assert.equal(manifest.background.service_worker, 'background.js');
assert.equal(manifest.options_page, 'options/options.html');
assert.equal(manifest.oauth2, undefined, 'Distribution manifest should not contain a user-specific OAuth client ID.');

const publicKey = Buffer.from(manifest.key, 'base64');
const prefix = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
const extensionId = [...prefix]
  .map((character) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(character, 16)))
  .join('');
assert.equal(extensionId, 'pcdcgkbgimicaioepjbghpmmjadeghej');

const referencedFiles = new Set([
  manifest.background.service_worker,
  manifest.options_page,
  manifest.action.default_popup,
  ...Object.values(manifest.action.default_icon || {}),
  ...Object.values(manifest.icons || {})
]);

for (const contentScript of manifest.content_scripts || []) {
  for (const file of contentScript.js || []) {
    referencedFiles.add(file);
  }
  for (const file of contentScript.css || []) {
    referencedFiles.add(file);
  }
}

for (const relativePath of referencedFiles) {
  assert.equal(
    fs.existsSync(path.join(root, relativePath)),
    true,
    `Manifest references missing file: ${relativePath}`
  );
}

const slackScript = (manifest.content_scripts || []).find((entry) =>
  (entry.matches || []).includes('https://*.slack.com/*')
);
assert.ok(slackScript, 'Slack content script is missing.');
assert.deepEqual(slackScript.js, [
  'src/common.js',
  'src/availability-utils.js',
  'src/slack.js'
]);
assert.ok(manifest.permissions.includes('identity'));
assert.ok(manifest.host_permissions.includes('https://www.googleapis.com/*'));

console.log(`manifest/references: all tests passed (${extensionId})`);
