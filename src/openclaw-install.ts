import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  cp,
  lchown,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { HostConfigSchema } from "./host-config.js";
import { atomicWriteFile } from "./store.js";
import { acquireProcessDirectoryLock } from "./process-lock.js";
import {
  CONTROL_DATABASE_NAME,
  CONTROL_SCHEMA_VERSION,
  inspectControlMigrations,
} from "./sqlite.js";

const PLUGIN_ID = "prime-dispatch";
const INSTALL_SCHEMA_VERSION = 1;
const RELEASE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const INSTALL_LOCK_STALE_MS = 30_000;
const CONFIG_REPLACE_PATHS = [
  "plugins.allow",
  'plugins.entries["prime-dispatch"]',
];
const RELEASE_SOURCE_PATHS = [
  { source: "dist", prepared: "runtime/dist", label: "dist" },
  {
    source: "package.json",
    prepared: "runtime/package.json",
    label: "package.json",
  },
  {
    source: "pnpm-lock.yaml",
    prepared: "runtime/pnpm-lock.yaml",
    label: "pnpm-lock.yaml",
  },
  {
    source: "openclaw-plugin/dist",
    prepared: "plugin/dist",
    label: "openclaw-plugin/dist",
  },
  {
    source: "openclaw-plugin/openclaw.plugin.json",
    prepared: "plugin/openclaw.plugin.json",
    label: "openclaw-plugin/openclaw.plugin.json",
  },
  {
    source: "openclaw-plugin/package.json",
    prepared: "plugin/package.json",
    label: "openclaw-plugin/package.json",
  },
  {
    source: "openclaw-plugin/pnpm-lock.yaml",
    prepared: "plugin/pnpm-lock.yaml",
    label: "openclaw-plugin/pnpm-lock.yaml",
  },
  {
    source: "openclaw-plugin/pnpm-workspace.yaml",
    prepared: "plugin/pnpm-workspace.yaml",
    label: "openclaw-plugin/pnpm-workspace.yaml",
  },
  {
    source: "openclaw-plugin/README.md",
    prepared: "plugin/README.md",
    label: "openclaw-plugin/README.md",
  },
] as const;

export type OpenClawInstallLayout = {
  openclawStateDir: string;
  openclawConfigPath: string;
  installRoot: string;
  releasesRoot: string;
  backupsRoot: string;
  configRoot: string;
  hostConfigPath: string;
  stateRoot: string;
  currentLink: string;
  extensionPath: string;
  installManifestPath: string;
  lockPath: string;
};

export type OpenClawPluginConfig = {
  confirmationTtlMs?: number;
  maxRenderedChars?: number;
  notificationPollMs?: number;
};

export type OpenClawLifecycleDependencies = {
  installProductionDependencies(path: string): Promise<void>;
  readConfigValue(path: string): Promise<unknown>;
  applyConfigPatch(
    patch: Record<string, unknown>,
    replacePaths?: string[],
  ): Promise<void>;
  validateConfig(): Promise<void>;
  refreshPluginRegistry(): Promise<void>;
  readPluginSource(): Promise<string | undefined>;
  restartGateway(): Promise<void>;
  now(): Date;
};

export type PlanOpenClawInstallOptions = OpenClawPluginConfig & {
  openclawStateDir: string;
  releaseId?: string;
};

export type InstallOpenClawOptions = PlanOpenClawInstallOptions & {
  sourceRoot: string;
  hostConfigSource: string;
  stateSource?: string;
  restartGateway?: boolean;
};

export type ActiveOpenClawOptions = OpenClawPluginConfig & {
  openclawStateDir: string;
  restartGateway?: boolean;
};

type InstallManifest = {
  schemaVersion: 1;
  active: boolean;
  currentRelease: string;
  previousRelease?: string;
  installedAt: string;
  updatedAt: string;
  releases: Array<{
    id: string;
    sourceDigest: string;
    publishedDigest?: string;
    installedAt: string;
  }>;
};

type ReleaseMetadata = {
  schemaVersion: 1;
  releaseId: string;
  sourceDigest: string;
  publishedDigest?: string;
  preparedAt: string;
};

type ConfigSnapshot = {
  allow: string[];
  entry: unknown;
};

type PathRestore = {
  restore(): Promise<void>;
};

export function openClawLayout(
  openclawStateDir: string,
): OpenClawInstallLayout {
  const stateDir = resolve(openclawStateDir);
  const installRoot = join(stateDir, PLUGIN_ID);
  return {
    openclawStateDir: stateDir,
    openclawConfigPath: join(stateDir, "openclaw.json"),
    installRoot,
    releasesRoot: join(installRoot, "releases"),
    backupsRoot: join(installRoot, "backups"),
    configRoot: join(installRoot, "config"),
    hostConfigPath: join(installRoot, "config", "host.json"),
    stateRoot: join(installRoot, "state"),
    currentLink: join(installRoot, "current"),
    extensionPath: join(stateDir, "extensions", PLUGIN_ID),
    installManifestPath: join(installRoot, "install.json"),
    lockPath: join(installRoot, ".install.lock"),
  };
}

export async function planOpenClawInstall(
  options: PlanOpenClawInstallOptions,
  dependencies: Pick<OpenClawLifecycleDependencies, "readConfigValue">,
): Promise<{
  releaseId?: string;
  configPatch: Record<string, unknown>;
  paths: Pick<
    OpenClawInstallLayout,
    | "installRoot"
    | "releasesRoot"
    | "hostConfigPath"
    | "stateRoot"
    | "currentLink"
    | "extensionPath"
  >;
}> {
  validatePluginConfig(options);
  if (options.releaseId) validateReleaseId(options.releaseId);
  const layout = openClawLayout(options.openclawStateDir);
  const snapshot = await readConfigSnapshot(dependencies);
  return {
    ...(options.releaseId ? { releaseId: options.releaseId } : {}),
    configPatch: installConfigPatch(layout, snapshot.allow, options),
    paths: {
      installRoot: layout.installRoot,
      releasesRoot: layout.releasesRoot,
      hostConfigPath: layout.hostConfigPath,
      stateRoot: layout.stateRoot,
      currentLink: layout.currentLink,
      extensionPath: layout.extensionPath,
    },
  };
}

export async function installOpenClaw(
  options: InstallOpenClawOptions,
  dependencies: OpenClawLifecycleDependencies,
): Promise<{
  changed: boolean;
  currentRelease: string;
  previousRelease?: string;
  configPatch: Record<string, unknown>;
}> {
  validatePluginConfig(options);
  const layout = openClawLayout(options.openclawStateDir);
  await ensureInstallDirectories(layout);
  const releaseLock = await acquireInstallLock(layout);
  try {
    const sourceRoot = await realpath(options.sourceRoot);
    const sourceDigest = await digestReleaseSource(sourceRoot);
    const releaseId = options.releaseId ?? sourceDigest.slice(0, 16);
    validateReleaseId(releaseId);
    const releaseRoot = join(layout.releasesRoot, releaseId);
    const existingManifest = await readInstallManifest(layout);
    const snapshot = await readConfigSnapshot(dependencies);
    const configPatch = installConfigPatch(layout, snapshot.allow, options);
    const desiredEntry = installConfigEntry(layout, options);

    if (
      existingManifest?.active === true &&
      existingManifest.currentRelease === releaseId &&
      (await releaseMatches(releaseRoot, releaseId, sourceDigest)) &&
      (await linkTargets(layout.currentLink, join("releases", releaseId))) &&
      (await linkResolvesTo(
        layout.extensionPath,
        join(releaseRoot, "plugin"),
      )) &&
      isDeepStrictEqual(snapshot.entry, desiredEntry) &&
      snapshot.allow.includes(PLUGIN_ID) &&
      (await hostConfigMatches(
        options.hostConfigSource,
        layout.hostConfigPath,
      )) &&
      rollbackReferenceIsVerified(existingManifest)
    ) {
      await dependencies.refreshPluginRegistry();
      if (options.restartGateway) {
        try {
          await dependencies.restartGateway();
        } catch (error) {
          throw new Error(
            `repaired ${releaseId} registry but gateway restart failed: ${errorMessage(error)}`,
            { cause: error },
          );
        }
      }
      return {
        changed: false,
        currentRelease: releaseId,
        ...(existingManifest.previousRelease
          ? { previousRelease: existingManifest.previousRelease }
          : {}),
        configPatch,
      };
    }

    const releaseMetadata = await prepareRelease(
      sourceRoot,
      releaseRoot,
      releaseId,
      sourceDigest,
      layout,
      dependencies,
    );
    const hostConfigRestore = await installHostConfig(
      options.hostConfigSource,
      layout,
      dependencies.now(),
    );
    try {
      await initializeState(options.stateSource, layout);
    } catch (error) {
      await hostConfigRestore();
      throw error;
    }

    const currentRestore = await switchDirectoryLink(
      layout.currentLink,
      join("releases", releaseId),
      layout,
      "current",
    );
    let extensionRestore: PathRestore | undefined;
    let manifest: InstallManifest;
    try {
      extensionRestore = await switchDirectoryLink(
        layout.extensionPath,
        relative(dirname(layout.extensionPath), join(releaseRoot, "plugin")),
        layout,
        "extension",
      );
      await dependencies.applyConfigPatch(configPatch, CONFIG_REPLACE_PATHS);
      await dependencies.validateConfig();
      await dependencies.refreshPluginRegistry();

      const now = dependencies.now().toISOString();
      const previousRelease = selectVerifiedRollbackRelease(
        existingManifest,
        releaseId,
      );
      manifest = {
        schemaVersion: INSTALL_SCHEMA_VERSION,
        active: true,
        currentRelease: releaseId,
        ...(previousRelease ? { previousRelease } : {}),
        installedAt: existingManifest?.installedAt ?? now,
        updatedAt: now,
        releases: upsertRelease(
          existingManifest?.releases ?? [],
          releaseId,
          sourceDigest,
          requirePublishedDigest(releaseMetadata),
          now,
        ),
      };
      await writeInstallManifest(layout, manifest);
    } catch (error) {
      await extensionRestore?.restore().catch(() => undefined);
      await currentRestore.restore().catch(() => undefined);
      await restoreConfigSnapshot(snapshot, dependencies, desiredEntry).catch(
        () => undefined,
      );
      await dependencies.refreshPluginRegistry().catch(() => undefined);
      await hostConfigRestore().catch(() => undefined);
      throw error;
    }
    if (options.restartGateway) {
      try {
        await dependencies.restartGateway();
      } catch (error) {
        throw new Error(
          `installed ${releaseId} but gateway restart failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
    return {
      changed: true,
      currentRelease: manifest.currentRelease,
      ...(manifest.previousRelease
        ? { previousRelease: manifest.previousRelease }
        : {}),
      configPatch,
    };
  } finally {
    await releaseLock();
  }
}

export async function rollbackOpenClaw(
  options: ActiveOpenClawOptions,
  dependencies: OpenClawLifecycleDependencies,
): Promise<{
  currentRelease: string;
  previousRelease: string;
  configPatch: Record<string, unknown>;
}> {
  validatePluginConfig(options);
  const layout = openClawLayout(options.openclawStateDir);
  await ensureInstallDirectories(layout);
  const releaseLock = await acquireInstallLock(layout);
  try {
    const manifest = await readInstallManifest(layout);
    if (!manifest?.previousRelease)
      throw new Error("no previous Prime Dispatch release is available");
    const targetRelease = manifest.previousRelease;
    const targetRoot = join(layout.releasesRoot, targetRelease);
    const targetEntry = manifest.releases.find(
      (release) => release.id === targetRelease,
    );
    if (
      !targetEntry?.publishedDigest ||
      !(await releaseMatches(
        targetRoot,
        targetRelease,
        targetEntry.sourceDigest,
        targetEntry.publishedDigest,
      ))
    )
      throw new Error(
        `release ${targetRelease} failed published-content verification`,
      );
    const snapshot = await readConfigSnapshot(dependencies);
    const configPatch = installConfigPatch(layout, snapshot.allow, options);
    const currentRestore = await switchDirectoryLink(
      layout.currentLink,
      join("releases", targetRelease),
      layout,
      "current",
    );
    let extensionRestore: PathRestore | undefined;
    let next: InstallManifest;
    try {
      extensionRestore = await switchDirectoryLink(
        layout.extensionPath,
        relative(dirname(layout.extensionPath), join(targetRoot, "plugin")),
        layout,
        "extension",
      );
      await dependencies.applyConfigPatch(configPatch, CONFIG_REPLACE_PATHS);
      await dependencies.validateConfig();
      await dependencies.refreshPluginRegistry();
      next = {
        ...manifest,
        active: true,
        currentRelease: targetRelease,
        previousRelease: manifest.currentRelease,
        updatedAt: dependencies.now().toISOString(),
      };
      await writeInstallManifest(layout, next);
    } catch (error) {
      await extensionRestore?.restore().catch(() => undefined);
      await currentRestore.restore().catch(() => undefined);
      await restoreConfigSnapshot(snapshot, dependencies).catch(
        () => undefined,
      );
      await dependencies.refreshPluginRegistry().catch(() => undefined);
      throw error;
    }
    if (options.restartGateway) {
      try {
        await dependencies.restartGateway();
      } catch (error) {
        throw new Error(
          `rolled back to ${targetRelease} but gateway restart failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
    return {
      currentRelease: next.currentRelease,
      previousRelease: manifest.currentRelease,
      configPatch,
    };
  } finally {
    await releaseLock();
  }
}

export async function uninstallOpenClaw(
  options: ActiveOpenClawOptions,
  dependencies: OpenClawLifecycleDependencies,
): Promise<{
  changed: boolean;
  preservedStateRoot: string;
  preservedHostConfigPath: string;
  configPatch: Record<string, unknown>;
}> {
  validatePluginConfig(options);
  const layout = openClawLayout(options.openclawStateDir);
  await ensureInstallDirectories(layout);
  const releaseLock = await acquireInstallLock(layout);
  try {
    const snapshot = await readConfigSnapshot(dependencies);
    const configPatch = uninstallConfigPatch(snapshot.allow, snapshot.entry);
    const manifest = await readInstallManifest(layout);
    let currentRestore: PathRestore | undefined;
    let extensionRestore: PathRestore | undefined;
    try {
      await dependencies.applyConfigPatch(configPatch, CONFIG_REPLACE_PATHS);
      await dependencies.validateConfig();
      currentRestore = await detachOwnedLink(
        layout.currentLink,
        layout.releasesRoot,
      );
      extensionRestore = await detachOwnedLink(
        layout.extensionPath,
        layout.releasesRoot,
      );
      await dependencies.refreshPluginRegistry();
      if (manifest) {
        await writeInstallManifest(layout, {
          ...manifest,
          active: false,
          updatedAt: dependencies.now().toISOString(),
        });
      }
    } catch (error) {
      await restoreConfigSnapshot(snapshot, dependencies).catch(
        () => undefined,
      );
      await extensionRestore?.restore().catch(() => undefined);
      await currentRestore?.restore().catch(() => undefined);
      await dependencies.refreshPluginRegistry().catch(() => undefined);
      if (manifest)
        await writeInstallManifest(layout, manifest).catch(() => undefined);
      throw error;
    }
    if (options.restartGateway) {
      try {
        await dependencies.restartGateway();
      } catch (error) {
        throw new Error(
          `uninstalled Prime Dispatch but gateway restart failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
    return {
      changed: Boolean(
        manifest?.active ??
          (snapshot.entry as { enabled?: unknown } | undefined)?.enabled,
      ),
      preservedStateRoot: layout.stateRoot,
      preservedHostConfigPath: layout.hostConfigPath,
      configPatch,
    };
  } finally {
    await releaseLock();
  }
}

export async function auditOpenClawInstall(
  openclawStateDir: string,
  dependencies?: Pick<OpenClawLifecycleDependencies, "readPluginSource">,
): Promise<string[]> {
  const layout = openClawLayout(openclawStateDir);
  const violations: string[] = [];
  for (const [path, mode] of [
    [layout.installRoot, 0o700],
    [layout.releasesRoot, 0o700],
    [layout.backupsRoot, 0o700],
    [layout.configRoot, 0o700],
    [layout.stateRoot, 0o700],
  ] as const)
    await auditPath(path, mode, "directory", violations);
  await auditPath(layout.hostConfigPath, 0o600, "file", violations);
  await auditPath(layout.installManifestPath, 0o600, "file", violations);
  await readFile(layout.hostConfigPath, "utf8")
    .then((raw) => HostConfigSchema.parse(JSON.parse(raw)))
    .catch((error: unknown) =>
      violations.push(`host config is invalid: ${errorMessage(error)}`),
    );
  await auditControlDatabase(layout.stateRoot, violations);

  const manifest = await readInstallManifest(layout).catch((error: unknown) => {
    violations.push(
      `install manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  });
  if (!manifest) {
    if (!(await pathExists(layout.installManifestPath)))
      violations.push("install manifest is missing");
    return violations;
  }
  for (const release of manifest.releases) {
    const releaseRoot = join(layout.releasesRoot, release.id);
    const canonicalReleaseRoot = await realpath(releaseRoot).catch(() =>
      resolve(releaseRoot),
    );
    await auditSecureTree(releaseRoot, canonicalReleaseRoot, violations);
    const metadata = await readReleaseMetadata(releaseRoot).catch(
      (error: unknown) => {
        violations.push(
          `release metadata is invalid in ${releaseRoot}: ${errorMessage(error)}`,
        );
        return undefined;
      },
    );
    if (
      metadata &&
      (metadata.releaseId !== release.id ||
        metadata.sourceDigest !== release.sourceDigest ||
        metadata.publishedDigest !== release.publishedDigest)
    )
      violations.push(
        `release metadata does not match install manifest: ${releaseRoot}`,
      );
    const actualDigest = await digestPreparedReleaseSource(releaseRoot).catch(
      (error: unknown) => {
        violations.push(
          `release source is invalid in ${releaseRoot}: ${errorMessage(error)}`,
        );
        return undefined;
      },
    );
    if (actualDigest && actualDigest !== release.sourceDigest)
      violations.push(
        `source digest does not match release metadata: ${releaseRoot}`,
      );
    const publishedDigest = await digestPublishedRelease(releaseRoot).catch(
      (error: unknown) => {
        violations.push(
          `published release content is invalid in ${releaseRoot}: ${errorMessage(error)}`,
        );
        return undefined;
      },
    );
    const rollbackEligible =
      release.id === manifest.currentRelease ||
      release.id === manifest.previousRelease;
    if (
      rollbackEligible &&
      (!release.publishedDigest || !metadata?.publishedDigest)
    )
      violations.push(
        `published content digest is missing from release metadata: ${releaseRoot}`,
      );
    else if (
      publishedDigest &&
      release.publishedDigest &&
      metadata?.publishedDigest &&
      (publishedDigest !== release.publishedDigest ||
        publishedDigest !== metadata.publishedDigest)
    )
      violations.push(
        `published content digest does not match release metadata: ${releaseRoot}`,
      );
  }
  if (manifest.active) {
    await auditOwnedLink(
      layout.currentLink,
      join(layout.releasesRoot, manifest.currentRelease),
      violations,
    );
    await auditOwnedLink(
      layout.extensionPath,
      join(layout.releasesRoot, manifest.currentRelease, "plugin"),
      violations,
    );
    if (dependencies) {
      const expectedSource = join(
        layout.releasesRoot,
        manifest.currentRelease,
        "plugin",
        "dist",
        "index.js",
      );
      const activeSource = await dependencies
        .readPluginSource()
        .catch((error: unknown) => {
          violations.push(
            `persisted plugin source could not be read: ${errorMessage(error)}`,
          );
          return undefined;
        });
      if (!activeSource) violations.push("persisted plugin source is missing");
      else {
        const [expectedCanonical, activeCanonical] = await Promise.all([
          realpath(expectedSource).catch(() => resolve(expectedSource)),
          realpath(activeSource).catch(() => resolve(activeSource)),
        ]);
        if (activeCanonical !== expectedCanonical)
          violations.push(
            `persisted plugin source targets another release: ${activeSource}`,
          );
      }
    }
  }
  return violations;
}

async function auditControlDatabase(
  stateRoot: string,
  violations: string[],
): Promise<void> {
  const path = join(stateRoot, CONTROL_DATABASE_NAME);
  if (!(await pathExists(path))) return;
  await auditPath(path, 0o600, "file", violations);
  for (const suffix of ["-wal", "-shm"])
    if (await pathExists(`${path}${suffix}`))
      await auditPath(`${path}${suffix}`, 0o600, "file", violations);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: unknown }
      | undefined;
    if (integrity?.integrity_check !== "ok")
      violations.push("control database integrity check failed");
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0)
      violations.push("control database foreign-key check failed");
    const migration = inspectControlMigrations(database);
    if (migration.currentVersion !== CONTROL_SCHEMA_VERSION)
      violations.push(
        `control database schema is ${migration.currentVersion}; expected ${CONTROL_SCHEMA_VERSION}`,
      );
  } catch (error) {
    violations.push(`control database is invalid: ${errorMessage(error)}`);
  } finally {
    database?.close();
  }
}

function installConfigPatch(
  layout: OpenClawInstallLayout,
  currentAllow: string[],
  options: OpenClawPluginConfig,
): Record<string, unknown> {
  return {
    plugins: {
      allow: currentAllow.includes(PLUGIN_ID)
        ? currentAllow
        : [...currentAllow, PLUGIN_ID],
      entries: {
        [PLUGIN_ID]: installConfigEntry(layout, options),
      },
    },
  };
}

function installConfigEntry(
  layout: OpenClawInstallLayout,
  options: OpenClawPluginConfig,
): Record<string, unknown> {
  return {
    enabled: true,
    config: {
      cliPath: join(layout.currentLink, "runtime", "dist", "cli.js"),
      stateRoot: layout.stateRoot,
      hostConfigPath: layout.hostConfigPath,
      openclawStateDir: layout.openclawStateDir,
      openclawConfigPath: layout.openclawConfigPath,
      confirmationTtlMs: options.confirmationTtlMs ?? 300_000,
      maxRenderedChars: options.maxRenderedChars ?? 1_800,
      notificationPollMs: options.notificationPollMs ?? 2_000,
    },
  };
}

function uninstallConfigPatch(
  currentAllow: string[],
  currentEntry: unknown,
): Record<string, unknown> {
  let disabledEntry: Record<string, unknown> | undefined;
  if (
    currentEntry !== null &&
    typeof currentEntry === "object" &&
    !Array.isArray(currentEntry)
  )
    disabledEntry = {
      ...(currentEntry as Record<string, unknown>),
      enabled: false,
    };
  return {
    plugins: {
      allow: currentAllow.filter((id) => id !== PLUGIN_ID),
      entries: disabledEntry ? { [PLUGIN_ID]: disabledEntry } : {},
    },
  };
}

function validatePluginConfig(options: OpenClawPluginConfig): void {
  for (const [name, value] of [
    ["confirmationTtlMs", options.confirmationTtlMs],
    ["maxRenderedChars", options.maxRenderedChars],
    ["notificationPollMs", options.notificationPollMs],
  ] as const)
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new Error(`${name} must be a positive integer`);
}

async function readConfigSnapshot(
  dependencies: Pick<OpenClawLifecycleDependencies, "readConfigValue">,
): Promise<ConfigSnapshot> {
  const rawAllow = await dependencies.readConfigValue("plugins.allow");
  if (
    rawAllow !== undefined &&
    (!Array.isArray(rawAllow) ||
      rawAllow.some((value) => typeof value !== "string" || !value))
  )
    throw new Error("OpenClaw plugins.allow must be an array of plugin ids");
  return {
    allow: rawAllow === undefined ? [] : [...rawAllow],
    entry: await dependencies.readConfigValue(
      'plugins.entries["prime-dispatch"]',
    ),
  };
}

async function restoreConfigSnapshot(
  snapshot: ConfigSnapshot,
  dependencies: OpenClawLifecycleDependencies,
  fallbackEntry?: Record<string, unknown>,
): Promise<void> {
  const entry =
    snapshot.entry ??
    (fallbackEntry ? { ...fallbackEntry, enabled: false } : { enabled: false });
  await dependencies.applyConfigPatch(
    {
      plugins: {
        allow: snapshot.allow,
        entries: {
          [PLUGIN_ID]: entry,
        },
      },
    },
    CONFIG_REPLACE_PATHS,
  );
}

async function ensureInstallDirectories(
  layout: OpenClawInstallLayout,
): Promise<void> {
  for (const path of [
    layout.installRoot,
    layout.releasesRoot,
    layout.backupsRoot,
    layout.configRoot,
  ]) {
    await ensureRealDirectory(path, true);
  }
  await ensureRealDirectory(dirname(layout.extensionPath), false);
}

async function ensureRealDirectory(
  path: string,
  owned: boolean,
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const value = await lstat(path);
  if (value.isSymbolicLink() || !value.isDirectory())
    throw new Error(
      `${owned ? "owned install" : "OpenClaw extensions"} path must be a real directory: ${path}`,
    );
  if (owned) {
    await establishOwnership(path);
    await chmod(path, 0o700);
  }
}

function acquireInstallLock(
  layout: OpenClawInstallLayout,
): Promise<() => Promise<void>> {
  return acquireProcessDirectoryLock(layout.lockPath, {
    staleMs: INSTALL_LOCK_STALE_MS,
    timeoutMs: 0,
    busyError: "Prime Dispatch OpenClaw lifecycle is already running",
    identityError: "could not identify OpenClaw lifecycle process",
  });
}

async function prepareRelease(
  sourceRoot: string,
  releaseRoot: string,
  releaseId: string,
  sourceDigest: string,
  layout: OpenClawInstallLayout,
  dependencies: OpenClawLifecycleDependencies,
): Promise<ReleaseMetadata> {
  if (await pathExists(releaseRoot)) {
    if (!(await releaseMatches(releaseRoot, releaseId, sourceDigest)))
      throw new Error(`release ${releaseId} already exists with other content`);
    return await readReleaseMetadata(releaseRoot);
  }
  const staging = join(
    layout.releasesRoot,
    `.${releaseId}.staging-${randomUUID()}`,
  );
  await mkdir(staging, { mode: 0o700 });
  try {
    const runtimeRoot = join(staging, "runtime");
    const pluginRoot = join(staging, "plugin");
    await copyRequiredEntries(sourceRoot, runtimeRoot, [
      "dist",
      "package.json",
      "pnpm-lock.yaml",
    ]);
    await copyRequiredEntries(join(sourceRoot, "openclaw-plugin"), pluginRoot, [
      "dist",
      "openclaw.plugin.json",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "README.md",
    ]);
    await dependencies.installProductionDependencies(runtimeRoot);
    await dependencies.installProductionDependencies(pluginRoot);
    const publishedDigest = await digestPublishedRelease(staging);
    const metadata: ReleaseMetadata = {
      schemaVersion: INSTALL_SCHEMA_VERSION,
      releaseId,
      sourceDigest,
      publishedDigest,
      preparedAt: dependencies.now().toISOString(),
    };
    await atomicWriteFile(
      join(staging, "release.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await secureTree(staging);
    await rename(staging, releaseRoot);
    return metadata;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function copyRequiredEntries(
  sourceRoot: string,
  destinationRoot: string,
  entries: string[],
): Promise<void> {
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const source = join(sourceRoot, entry);
    const sourceStat = await lstat(source).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          throw new Error(`release source is missing ${source}`);
        throw error;
      },
    );
    if (sourceStat.isSymbolicLink())
      throw new Error(`release source cannot be a symlink: ${source}`);
    await cp(source, join(destinationRoot, entry), {
      recursive: sourceStat.isDirectory(),
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
  }
}

async function digestReleaseSource(sourceRoot: string): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of RELEASE_SOURCE_PATHS)
    await digestPath(join(sourceRoot, entry.source), entry.label, hash);
  return hash.digest("hex");
}

async function digestPreparedReleaseSource(
  releaseRoot: string,
): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of RELEASE_SOURCE_PATHS)
    await digestPath(join(releaseRoot, entry.prepared), entry.label, hash);
  return hash.digest("hex");
}

async function digestPublishedRelease(releaseRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const canonicalReleaseRoot = await realpath(releaseRoot);
  await digestPublishedPath(
    join(releaseRoot, "runtime"),
    "runtime",
    canonicalReleaseRoot,
    hash,
  );
  await digestPublishedPath(
    join(releaseRoot, "plugin"),
    "plugin",
    canonicalReleaseRoot,
    hash,
  );
  return hash.digest("hex");
}

async function digestPublishedPath(
  path: string,
  relativePath: string,
  releaseRoot: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const value = await lstat(path);
  if (value.isSymbolicLink()) {
    const target = await readlink(path);
    const canonicalTarget = await realpath(path).catch(() => undefined);
    if (!canonicalTarget || !isWithin(releaseRoot, canonicalTarget))
      throw new Error(`release symlink escapes ${releaseRoot}: ${path}`);
    hash.update(`l:${relativePath}\0${target}\0`);
    return;
  }
  hash.update(`${value.isDirectory() ? "d" : "f"}:${relativePath}\0`);
  if (value.isDirectory()) {
    for (const child of (await readdir(path)).sort())
      await digestPublishedPath(
        join(path, child),
        join(relativePath, child),
        releaseRoot,
        hash,
      );
  } else if (value.isFile()) {
    hash.update(await readFile(path));
  } else {
    throw new Error(`release contains an unsupported entry: ${path}`);
  }
}

async function digestPath(
  path: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const value = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      throw new Error(`release source is missing ${path}`);
    throw error;
  });
  if (value.isSymbolicLink())
    throw new Error(`release source cannot contain symlinks: ${path}`);
  hash.update(`${value.isDirectory() ? "d" : "f"}:${relativePath}\0`);
  if (value.isDirectory()) {
    for (const child of (await readdir(path)).sort())
      await digestPath(join(path, child), join(relativePath, child), hash);
  } else if (value.isFile()) {
    hash.update(await readFile(path));
  } else {
    throw new Error(`release source contains an unsupported entry: ${path}`);
  }
}

async function releaseMatches(
  releaseRoot: string,
  releaseId: string,
  sourceDigest: string,
  expectedPublishedDigest?: string,
): Promise<boolean> {
  const metadata = await readReleaseMetadata(releaseRoot).catch(
    () => undefined,
  );
  return (
    metadata?.releaseId === releaseId &&
    metadata.sourceDigest === sourceDigest &&
    Boolean(metadata.publishedDigest) &&
    (!expectedPublishedDigest ||
      metadata.publishedDigest === expectedPublishedDigest) &&
    (await digestPreparedReleaseSource(releaseRoot).catch(() => undefined)) ===
      sourceDigest &&
    (await digestPublishedRelease(releaseRoot).catch(() => undefined)) ===
      metadata.publishedDigest
  );
}

async function readReleaseMetadata(
  releaseRoot: string,
): Promise<ReleaseMetadata> {
  const value = JSON.parse(
    await readFile(join(releaseRoot, "release.json"), "utf8"),
  ) as Partial<ReleaseMetadata>;
  if (
    value.schemaVersion !== INSTALL_SCHEMA_VERSION ||
    typeof value.releaseId !== "string" ||
    typeof value.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
    (value.publishedDigest !== undefined &&
      (typeof value.publishedDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.publishedDigest))) ||
    typeof value.preparedAt !== "string"
  )
    throw new Error(`release metadata is invalid in ${releaseRoot}`);
  return value as ReleaseMetadata;
}

function requirePublishedDigest(metadata: ReleaseMetadata): string {
  if (!metadata.publishedDigest)
    throw new Error(
      `release ${metadata.releaseId} has no published content digest`,
    );
  return metadata.publishedDigest;
}

async function installHostConfig(
  source: string,
  layout: OpenClawInstallLayout,
  now: Date,
): Promise<() => Promise<void>> {
  const canonicalSource = await realpath(source);
  const raw = await readFile(canonicalSource, "utf8");
  HostConfigSchema.parse(JSON.parse(raw));
  const previous = await readFile(layout.hostConfigPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (previous?.equals(Buffer.from(raw))) return async () => undefined;
  let backupPath: string | undefined;
  if (previous) {
    backupPath = join(
      layout.backupsRoot,
      `host-${now.toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}.json`,
    );
    await atomicWriteFile(backupPath, previous.toString("utf8"));
    await chmod(backupPath, 0o600);
  }
  await atomicWriteFile(
    layout.hostConfigPath,
    raw.endsWith("\n") ? raw : `${raw}\n`,
  );
  await chmod(layout.hostConfigPath, 0o600);
  return async () => {
    if (previous) {
      await atomicWriteFile(layout.hostConfigPath, previous.toString("utf8"));
      await chmod(layout.hostConfigPath, 0o600);
    } else {
      await rm(layout.hostConfigPath, { force: true });
    }
    if (backupPath) await rm(backupPath, { force: true });
  };
}

async function hostConfigMatches(
  source: string,
  destination: string,
): Promise<boolean> {
  const sourceValue = HostConfigSchema.parse(
    JSON.parse(await readFile(await realpath(source), "utf8")),
  );
  const destinationRaw = await readFile(destination, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (destinationRaw === undefined) return false;
  try {
    const destinationValue = HostConfigSchema.parse(JSON.parse(destinationRaw));
    return isDeepStrictEqual(sourceValue, destinationValue);
  } catch {
    return false;
  }
}

async function initializeState(
  source: string | undefined,
  layout: OpenClawInstallLayout,
): Promise<void> {
  const existing = await lstat(layout.stateRoot).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory())
      throw new Error("durable state must be a real directory");
    await chmod(layout.stateRoot, 0o700);
    return;
  }
  if (!source) {
    await mkdir(layout.stateRoot, { mode: 0o700 });
    return;
  }
  const canonicalSource = await realpath(source);
  const sourceStat = await lstat(canonicalSource);
  if (!sourceStat.isDirectory())
    throw new Error("state source must be a directory");
  const absoluteSymlinks = await validateStateSymlinks(
    canonicalSource,
    canonicalSource,
  );
  const staging = `${layout.stateRoot}.staging-${randomUUID()}`;
  try {
    await cp(canonicalSource, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    for (const link of absoluteSymlinks) {
      const installedLink = join(staging, link.path);
      const installedTarget = join(staging, link.target);
      await rm(installedLink);
      await symlink(
        relative(dirname(installedLink), installedTarget),
        installedLink,
      );
    }
    await secureTree(staging);
    await rename(staging, layout.stateRoot);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

type StateSymlinkRewrite = { path: string; target: string };

async function validateStateSymlinks(
  path: string,
  root: string,
): Promise<StateSymlinkRewrite[]> {
  const value = await lstat(path);
  if (value.isSymbolicLink()) {
    const target = await realpath(path).catch(() => undefined);
    if (!target || !isWithin(root, target))
      throw new Error(`state source symlink escapes imported state: ${path}`);
    return isAbsolute(await readlink(path))
      ? [{ path: relative(root, path), target: relative(root, target) }]
      : [];
  }
  if (!value.isDirectory()) return [];
  const links: StateSymlinkRewrite[] = [];
  for (const child of await readdir(path))
    links.push(...(await validateStateSymlinks(join(path, child), root)));
  return links;
}

async function switchDirectoryLink(
  path: string,
  target: string,
  layout: OpenClawInstallLayout,
  label: string,
): Promise<PathRestore> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const old = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const oldLink = old?.isSymbolicLink() ? await readlink(path) : undefined;
  let backupPath: string | undefined;
  if (old && !old.isSymbolicLink()) {
    backupPath = join(
      layout.backupsRoot,
      `${label}-${Date.now()}-${randomUUID()}`,
    );
    await rename(path, backupPath);
  }
  await atomicDirectorySymlink(path, target);
  return {
    async restore() {
      await rm(path, { recursive: true, force: true });
      if (oldLink !== undefined) await atomicDirectorySymlink(path, oldLink);
      else if (backupPath) await rename(backupPath, path);
    },
  };
}

async function atomicDirectorySymlink(
  path: string,
  target: string,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await symlink(target, temporary, "dir");
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function linkTargets(path: string, target: string): Promise<boolean> {
  return await readlink(path)
    .then((value) => value === target)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EINVAL") return false;
      throw error;
    });
}

async function linkResolvesTo(path: string, target: string): Promise<boolean> {
  const resolved = await realpath(path).catch(() => undefined);
  const expected = await realpath(target).catch(() => resolve(target));
  return resolved === expected;
}

async function detachOwnedLink(
  path: string,
  releasesRoot: string,
): Promise<PathRestore> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return { restore: async () => undefined };
  if (!stat.isSymbolicLink())
    throw new Error(`refusing to remove non-symlink path ${path}`);
  const linkTarget = await readlink(path);
  const logicalTarget = resolve(dirname(path), linkTarget);
  const canonicalTarget = await realpath(path).catch(() => undefined);
  const canonicalReleasesRoot = await realpath(releasesRoot);
  const owned = canonicalTarget
    ? isWithin(canonicalReleasesRoot, canonicalTarget)
    : isWithin(releasesRoot, logicalTarget);
  if (!owned) throw new Error(`refusing to remove foreign symlink ${path}`);
  await rm(path);
  return {
    async restore() {
      if (!(await pathExists(path)))
        await atomicDirectorySymlink(path, linkTarget);
    },
  };
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(resolve(parent), resolve(child));
  return (
    relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..")
  );
}

async function readInstallManifest(
  layout: OpenClawInstallLayout,
): Promise<InstallManifest | undefined> {
  const raw = await readFile(layout.installManifestPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (raw === undefined) return undefined;
  const value = JSON.parse(raw) as Partial<InstallManifest>;
  if (
    value.schemaVersion !== INSTALL_SCHEMA_VERSION ||
    typeof value.active !== "boolean" ||
    typeof value.currentRelease !== "string" ||
    typeof value.installedAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.releases) ||
    value.releases.some(
      (release) =>
        !release ||
        typeof release.id !== "string" ||
        typeof release.sourceDigest !== "string" ||
        (release.publishedDigest !== undefined &&
          typeof release.publishedDigest !== "string") ||
        typeof release.installedAt !== "string",
    )
  )
    throw new Error("Prime Dispatch install manifest is invalid");
  if (
    !Number.isFinite(Date.parse(value.installedAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    throw new Error("Prime Dispatch install manifest timestamps are invalid");
  validateReleaseId(value.currentRelease);
  if (value.previousRelease) validateReleaseId(value.previousRelease);
  const releaseIds = new Set<string>();
  for (const release of value.releases) {
    validateReleaseId(release.id);
    if (!/^[a-f0-9]{64}$/.test(release.sourceDigest))
      throw new Error(`release ${release.id} has an invalid source digest`);
    if (
      release.publishedDigest !== undefined &&
      !/^[a-f0-9]{64}$/.test(release.publishedDigest)
    )
      throw new Error(`release ${release.id} has an invalid published digest`);
    if (!Number.isFinite(Date.parse(release.installedAt)))
      throw new Error(`release ${release.id} has an invalid install time`);
    if (releaseIds.has(release.id))
      throw new Error(`release ${release.id} is duplicated`);
    releaseIds.add(release.id);
  }
  if (!releaseIds.has(value.currentRelease))
    throw new Error("current release is absent from install manifest releases");
  if (value.previousRelease && !releaseIds.has(value.previousRelease))
    throw new Error(
      "previous release is absent from install manifest releases",
    );
  return value as InstallManifest;
}

async function writeInstallManifest(
  layout: OpenClawInstallLayout,
  manifest: InstallManifest,
): Promise<void> {
  await atomicWriteFile(
    layout.installManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await chmod(layout.installManifestPath, 0o600);
}

function upsertRelease(
  releases: InstallManifest["releases"],
  id: string,
  sourceDigest: string,
  publishedDigest: string,
  installedAt: string,
): InstallManifest["releases"] {
  const existing = releases.find((release) => release.id === id);
  if (existing) {
    if (existing.sourceDigest !== sourceDigest)
      throw new Error(`release ${id} has conflicting source digests`);
    if (
      existing.publishedDigest &&
      existing.publishedDigest !== publishedDigest
    )
      throw new Error(`release ${id} has conflicting published digests`);
    return releases.map((release) =>
      release.id === id ? { ...release, publishedDigest } : release,
    );
  }
  return [...releases, { id, sourceDigest, publishedDigest, installedAt }];
}

function selectVerifiedRollbackRelease(
  manifest: InstallManifest | undefined,
  nextRelease: string,
): string | undefined {
  if (!manifest) return undefined;
  for (const candidate of [manifest.currentRelease, manifest.previousRelease]) {
    if (
      candidate &&
      candidate !== nextRelease &&
      releaseHasPublishedDigest(manifest, candidate)
    )
      return candidate;
  }
  return undefined;
}

function rollbackReferenceIsVerified(
  manifest: InstallManifest | undefined,
): boolean {
  return (
    !manifest?.previousRelease ||
    releaseHasPublishedDigest(manifest, manifest.previousRelease)
  );
}

function releaseHasPublishedDigest(
  manifest: InstallManifest,
  releaseId: string,
): boolean {
  return manifest.releases.some(
    (release) => release.id === releaseId && Boolean(release.publishedDigest),
  );
}

function validateReleaseId(value: string): void {
  if (
    value.length > 128 ||
    !RELEASE_ID_PATTERN.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new Error(`invalid Prime Dispatch release id: ${value}`);
}

async function secureTree(path: string): Promise<void> {
  const value = await lstat(path);
  await establishOwnership(path, value.isSymbolicLink());
  if (value.isSymbolicLink()) return;
  if (value.isDirectory()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path))
      await secureTree(join(path, child));
  } else if (value.isFile()) {
    await chmod(path, 0o600);
  }
}

async function establishOwnership(
  path: string,
  symbolicLink = false,
): Promise<void> {
  if (!process.getuid || !process.getgid) return;
  const update = symbolicLink ? lchown : chown;
  await update(path, process.getuid(), process.getgid());
}

async function auditSecureTree(
  path: string,
  releaseRoot: string,
  violations: string[],
): Promise<void> {
  const value = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!value) {
    violations.push(`release path is missing: ${path}`);
    return;
  }
  if (value.isSymbolicLink()) {
    const target = await realpath(path).catch(() => undefined);
    if (!target || !isWithin(releaseRoot, target))
      violations.push(`release symlink escapes ${releaseRoot}: ${path}`);
    auditOwnership(path, value.uid, value.gid, violations);
    return;
  }
  const expected = value.isDirectory() ? 0o700 : 0o600;
  if ((value.mode & 0o777) !== expected)
    violations.push(
      `${path} must have mode ${expected.toString(8).padStart(4, "0")}`,
    );
  auditOwnership(path, value.uid, value.gid, violations);
  if (value.isDirectory())
    for (const child of await readdir(path))
      await auditSecureTree(join(path, child), releaseRoot, violations);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function auditPath(
  path: string,
  expectedMode: number,
  kind: "directory" | "file",
  violations: string[],
): Promise<void> {
  const value = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!value) {
    violations.push(`${path} is missing`);
    return;
  }
  if (kind === "directory" ? !value.isDirectory() : !value.isFile())
    violations.push(`${path} must be a ${kind}`);
  if ((value.mode & 0o777) !== expectedMode)
    violations.push(
      `${path} must have mode ${expectedMode.toString(8).padStart(4, "0")}`,
    );
  auditOwnership(path, value.uid, value.gid, violations);
}

function auditOwnership(
  path: string,
  uid: number,
  gid: number,
  violations: string[],
): void {
  if (process.getuid && uid !== process.getuid())
    violations.push(`${path} is not owned by uid ${process.getuid()}`);
  if (process.getgid && gid !== process.getgid())
    violations.push(`${path} is not owned by gid ${process.getgid()}`);
}

async function auditOwnedLink(
  path: string,
  expectedTarget: string,
  violations: string[],
): Promise<void> {
  const value = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!value) {
    violations.push(`${path} is missing`);
    return;
  }
  if (!value.isSymbolicLink()) {
    violations.push(`${path} must be a symlink`);
    return;
  }
  const target = await realpath(path).catch(() => undefined);
  const expected = await realpath(expectedTarget).catch(() =>
    resolve(expectedTarget),
  );
  if (target !== expected)
    violations.push(`${path} resolves outside the active release`);
}

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}
