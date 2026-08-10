import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Keeps manifest.json and versions.json in step with package.json.
 * Run automatically by `npm version` (see the "version" script).
 */

const targetVersion = process.env['npm_package_version'];
if (!targetVersion) {
  console.error('npm_package_version is not set. Run this through `npm version`.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', `${JSON.stringify(versions, null, 2)}\n`);

console.log(`Set version ${targetVersion} (minAppVersion ${minAppVersion}).`);
