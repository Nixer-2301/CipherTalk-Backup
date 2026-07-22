import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const allowedBumps = new Set(['patch', 'minor', 'major']);
const bumpType = process.argv[2] || 'patch';

if (!allowedBumps.has(bumpType)) {
  throw new Error(`不支持的版本递增类型：${bumpType}`);
}

const packagePath = join(process.cwd(), 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));

function runNpm(args, options = {}) {
  const npmCliCandidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);

  for (const npmCli of npmCliCandidates) {
    if (existsSync(npmCli)) {
      return execFileSync(process.execPath, [npmCli, ...args], options);
    }
  }

  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], options);
  }

  return execFileSync('npm', args, options);
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version);
  if (!match) {
    throw new Error(`无法解析版本号：${version}`);
  }

  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) {
      return 1;
    }

    if (leftParts[index] < rightParts[index]) {
      return -1;
    }
  }

  return 0;
}

function bumpVersion(version, type) {
  const [major, minor, patch] = parseVersion(version);

  if (type === 'major') {
    return `${major + 1}.0.0`;
  }

  if (type === 'minor') {
    return `${major}.${minor + 1}.0`;
  }

  return `${major}.${minor}.${patch + 1}`;
}

function getPublishedVersion(packageName) {
  try {
    return runNpm(['view', packageName, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = String(error.stderr || '');

    if (stderr.includes('E404') || stderr.includes('is not in this registry')) {
      return null;
    }

    throw error;
  }
}

const publishedVersion = getPublishedVersion(packageJson.name);
const currentVersion = packageJson.version;
const automaticVersion = publishedVersion ? bumpVersion(publishedVersion, bumpType) : currentVersion;
const targetVersion =
  publishedVersion && compareVersions(currentVersion, automaticVersion) < 0
    ? automaticVersion
    : currentVersion;
const changed = targetVersion !== currentVersion;

if (changed) {
  runNpm(['version', targetVersion, '--no-git-tag-version'], {
    stdio: 'inherit',
  });
} else {
  console.log(`版本保持为 ${targetVersion}`);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${targetVersion}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `published=${publishedVersion || ''}\n`);
}

console.log(
  `本次发布版本：${targetVersion}${publishedVersion ? `，npm 当前版本：${publishedVersion}` : ''}`,
);
