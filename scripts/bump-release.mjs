import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const RELEASE_PATH = "release/release.json";
const VERSION_PATHS = [
  "package.json",
  "openclaw-plugin/package.json",
  "openclaw-plugin/openclaw.plugin.json",
];
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|(?=[0-9A-Za-z-]*[A-Za-z-])[0-9A-Za-z-]+)(?:\.(?:0|[1-9]\d*|(?=[0-9A-Za-z-]*[A-Za-z-])[0-9A-Za-z-]+))*))?$/;
const execFileAsync = promisify(execFile);

export function parseReleaseVersion(value) {
  const match = VERSION_PATTERN.exec(value);
  if (!match)
    throw new Error(
      `invalid release version ${JSON.stringify(value)}; expected SemVer without build metadata`,
    );
  const core = match.slice(1, 4).map(Number);
  if (core.some((identifier) => !Number.isSafeInteger(identifier)))
    throw new Error(`release version ${JSON.stringify(value)} is too large`);
  return {
    major: core[0],
    minor: core[1],
    patch: core[2],
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareReleaseVersions(leftValue, rightValue) {
  const left = parseReleaseVersion(leftValue);
  const right = parseReleaseVersion(rightValue);
  for (const key of ["major", "minor", "patch"]) {
    const difference = left[key] - right[key];
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      if (leftIdentifier.length !== rightIdentifier.length)
        return Math.sign(leftIdentifier.length - rightIdentifier.length);
      return leftIdentifier < rightIdentifier ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function expectedPackageArtifacts(release, version) {
  const target = release.target;
  assert.equal(typeof target?.platform, "string");
  assert.equal(typeof target?.architecture, "string");
  assert.equal(typeof target?.nodeVersion, "string");
  const prefix = `prime-dispatch-openclaw-v${version}-${target.platform}-${target.architecture}-node-${target.nodeVersion}`;
  return {
    online: `${prefix}-online.tgz`,
    offline: `${prefix}-offline.tgz`,
  };
}

export async function bumpRelease({ root, version, dryRun = false }) {
  parseReleaseVersion(version);
  const releaseFile = await readJsonFile(root, RELEASE_PATH);
  const release = releaseFile.value;
  const versionedFiles = await Promise.all(
    VERSION_PATHS.map((path) => readJsonFile(root, path)),
  );
  const currentVersion = release.packageVersion;
  parseReleaseVersion(currentVersion);
  if (compareReleaseVersions(version, currentVersion) <= 0)
    throw new Error(
      `new release version ${version} must be greater than ${currentVersion}`,
    );
  assert.equal(release.packageReleaseTag, `v${currentVersion}`);
  assert.deepEqual(
    release.artifacts,
    expectedPackageArtifacts(release, currentVersion),
  );
  for (const file of versionedFiles)
    assert.equal(
      file.value.version,
      currentVersion,
      `${file.path} version must match ${RELEASE_PATH}`,
    );

  const nextRelease = {
    ...release,
    packageVersion: version,
    packageReleaseTag: `v${version}`,
    artifacts: expectedPackageArtifacts(release, version),
  };
  const nextArtifacts = nextRelease.artifacts;
  const updates = [
    {
      path: RELEASE_PATH,
      value: nextRelease,
      source: replaceJsonStringProperties(releaseFile.source, [
        ["packageVersion", currentVersion, version],
        ["packageReleaseTag", `v${currentVersion}`, `v${version}`],
        ["online", release.artifacts.online, nextArtifacts.online],
        ["offline", release.artifacts.offline, nextArtifacts.offline],
      ]),
    },
    ...versionedFiles.map((file) => ({
      path: file.path,
      value: { ...file.value, version },
      source: replaceJsonStringProperties(file.source, [
        ["version", currentVersion, version],
      ]),
    })),
  ];
  for (const update of updates)
    assert.deepEqual(
      JSON.parse(update.source),
      update.value,
      `${update.path} generated an unexpected document`,
    );
  if (!dryRun)
    for (const update of updates)
      await atomicWrite(resolve(root, update.path), update.source);
  return {
    currentVersion,
    nextVersion: version,
    dryRun,
    files: updates.map((update) => update.path),
  };
}

async function readJsonFile(root, path) {
  const source = await readFile(resolve(root, path), "utf8");
  return { path, source, value: JSON.parse(source) };
}

function replaceJsonStringProperties(source, replacements) {
  let next = source;
  for (const [property, current, replacement] of replacements) {
    const pattern = new RegExp(
      `(${escapeRegExp(JSON.stringify(property))}\\s*:\\s*)${escapeRegExp(JSON.stringify(current))}`,
      "g",
    );
    const matches = [...next.matchAll(pattern)];
    if (matches.length !== 1)
      throw new Error(
        `expected exactly one ${property} property with value ${JSON.stringify(current)}; found ${matches.length}`,
      );
    next = next.replace(pattern, `$1${JSON.stringify(replacement)}`);
  }
  return next;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function atomicWrite(path, source) {
  const temporary = `${path}.release-bump-${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, source, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function usage() {
  return "usage: pnpm release:bump <version> [--dry-run]";
}

async function main(arguments_) {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const dryRun = arguments_.includes("--dry-run");
  const positional = arguments_.filter((argument) => argument !== "--dry-run");
  const unknown = arguments_.filter(
    (argument) => argument.startsWith("-") && argument !== "--dry-run",
  );
  if (positional.length !== 1 || unknown.length > 0) throw new Error(usage());
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await runReleaseCheck(root);
  const result = await bumpRelease({ root, version: positional[0], dryRun });
  if (!dryRun) await runReleaseCheck(root);
  process.stdout.write(
    `${result.dryRun ? "would bump" : "bumped"} package release ${result.currentVersion} -> ${result.nextVersion}\n${result.files.join("\n")}\n`,
  );
}

async function runReleaseCheck(root) {
  await execFileAsync(
    process.execPath,
    [resolve(root, "scripts/check-release-config.mjs")],
    { cwd: root, encoding: "utf8" },
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
