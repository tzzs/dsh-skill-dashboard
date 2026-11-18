import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const config = await json('release-please-config.json');
const manifest = await json('.release-please-manifest.json');
assert.deepEqual(Object.keys(config.packages).sort(), ['skill-dashboard']);
assert.deepEqual(Object.keys(manifest).sort(), ['skill-dashboard']);
const release = config.packages['skill-dashboard'];
assert.equal(release['release-type'], 'node');
assert.equal(release['include-component-in-tag'], false);
assert.equal(release['include-v-in-tag'], true);
assert.equal(release['changelog-path'], 'CHANGELOG.md');

const pkg = await json('skill-dashboard/package.json');
const lock = await json('skill-dashboard/package-lock.json');
assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
assert.equal(manifest['skill-dashboard'], pkg.version, 'release manifest must match package version');
assert.equal(lock.version, pkg.version, 'lockfile version must match package version');
assert.equal(lock.packages[''].version, pkg.version, 'lockfile root must match package version');
assert.equal(lock.name, pkg.name);
assert.equal(pkg.private, true, 'this flow packages GitHub assets, not a public npm package');
for (const path of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json']) {
  await access(new URL('skill-dashboard/' + path, root));
}
console.log(`Release metadata is consistent: ${pkg.name}@${pkg.version}`);
