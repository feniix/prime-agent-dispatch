import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HostConfigSchema } from "./host-config.js";
import { atomicWriteFile } from "./store.js";

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
    installedAt: string;
  }>;
};

type ReleaseMetadata = {
  schemaVersion: 1;
  releaseId: string;
  sourceDigest: string;
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
      (await hostConfigMatches(options.hostConfigSource, layout.hostConfigPath))
    ) {
      return {
        changed: false,
        currentRelease: releaseId,
        ...(existingManifest.previousRelease
          ? { previousRelease: existingManifest.previousRelease }
          : {}),
        configPatch,
      };
    }

    await prepareRelease(
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

      const now = dependencies.now().toISOString();
      manifest = {
        schemaVersion: INSTALL_SCHEMA_VERSION,
        active: true,
        currentRelease: releaseId,
        ...(existingManifest?.currentRelease &&
        existingManifest.currentRelease !== releaseId
          ? { previousRelease: existingManifest.currentRelease }
          : existingManifest?.previousRelease
            ? { previousRelease: existingManifest.previousRelease }
            : {}),
        installedAt: existingManifest?.installedAt ?? now,
        updatedAt: now,
        releases: upsertRelease(
          existingManifest?.releases ?? [],
          releaseId,
          sourceDigest,
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
    await readReleaseMetadata(targetRoot);
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
        metadata.sourceDigest !== release.sourceDigest)
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
  }
  return violations;
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
  if (owned) await chmod(path, 0o700);
}

async function acquireInstallLock(
  layout: OpenClawInstallLayout,
): Promise<() => Promise<void>> {
  const nonce = randomUUID();
  while (true) {
    try {
      await mkdir(layout.lockPath, { mode: 0o700 });
      await atomicWriteFile(
        join(layout.lockPath, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          createdAtMs: Date.now(),
          nonce,
        })}\n`,
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await reclaimStaleInstallLock(layout)))
        throw new Error("Prime Dispatch OpenClaw lifecycle is already running");
    }
  }
  return async () => {
    const owner = await readInstallLockOwner(layout.lockPath).catch(
      () => undefined,
    );
    if (owner?.nonce === nonce)
      await rm(layout.lockPath, { recursive: true, force: true });
  };
}

type InstallLockOwner = {
  pid: number;
  createdAtMs: number;
  nonce: string;
};

async function reclaimStaleInstallLock(
  layout: OpenClawInstallLayout,
): Promise<boolean> {
  const owner = await readInstallLockOwner(layout.lockPath).catch(
    () => undefined,
  );
  let stale: boolean;
  if (owner) {
    stale =
      Date.now() - owner.createdAtMs > INSTALL_LOCK_STALE_MS &&
      !processExists(owner.pid);
  } else {
    const lockStat = await stat(layout.lockPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!lockStat) return true;
    stale = Date.now() - lockStat.mtimeMs > INSTALL_LOCK_STALE_MS;
  }
  if (!stale) return false;
  const abandoned = join(
    layout.installRoot,
    `.abandoned-install-lock-${randomUUID()}`,
  );
  try {
    await rename(layout.lockPath, abandoned);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(abandoned, { recursive: true, force: true });
  return true;
}

async function readInstallLockOwner(path: string): Promise<InstallLockOwner> {
  const value = JSON.parse(
    await readFile(join(path, "owner.json"), "utf8"),
  ) as Partial<InstallLockOwner>;
  if (
    !Number.isSafeInteger(value.pid) ||
    (value.pid ?? 0) <= 0 ||
    typeof value.createdAtMs !== "number" ||
    !Number.isFinite(value.createdAtMs) ||
    typeof value.nonce !== "string" ||
    !value.nonce
  )
    throw new Error("Prime Dispatch install lock owner is invalid");
  return value as InstallLockOwner;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function prepareRelease(
  sourceRoot: string,
  releaseRoot: string,
  releaseId: string,
  sourceDigest: string,
  layout: OpenClawInstallLayout,
  dependencies: OpenClawLifecycleDependencies,
): Promise<void> {
  if (await pathExists(releaseRoot)) {
    if (!(await releaseMatches(releaseRoot, releaseId, sourceDigest)))
      throw new Error(`release ${releaseId} already exists with other content`);
    return;
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
    const metadata: ReleaseMetadata = {
      schemaVersion: INSTALL_SCHEMA_VERSION,
      releaseId,
      sourceDigest,
      preparedAt: dependencies.now().toISOString(),
    };
    await atomicWriteFile(
      join(staging, "release.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await secureTree(staging);
    await rename(staging, releaseRoot);
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
): Promise<boolean> {
  const metadata = await readReleaseMetadata(releaseRoot).catch(
    () => undefined,
  );
  return (
    metadata?.releaseId === releaseId &&
    metadata.sourceDigest === sourceDigest &&
    (await digestPreparedReleaseSource(releaseRoot).catch(() => undefined)) ===
      sourceDigest
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
    typeof value.preparedAt !== "string"
  )
    throw new Error(`release metadata is invalid in ${releaseRoot}`);
  return value as ReleaseMetadata;
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
  installedAt: string,
): InstallManifest["releases"] {
  const existing = releases.find((release) => release.id === id);
  if (existing) {
    if (existing.sourceDigest !== sourceDigest)
      throw new Error(`release ${id} has conflicting source digests`);
    return releases;
  }
  return [...releases, { id, sourceDigest, installedAt }];
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
  if (value.isSymbolicLink()) return;
  if (value.isDirectory()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path))
      await secureTree(join(path, child));
  } else if (value.isFile()) {
    await chmod(path, 0o600);
  }
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
