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
  symlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HostConfigSchema } from "./host-config.js";
import { atomicWriteFile } from "./store.js";

const PLUGIN_ID = "prime-dispatch";
const INSTALL_SCHEMA_VERSION = 1;
const RELEASE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const CONFIG_REPLACE_PATHS = [
  "plugins.allow",
  'plugins.entries["prime-dispatch"]',
];

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
  replaceConfigValue(path: string, value: unknown): Promise<void>;
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
  plugins: Record<string, unknown>;
  allow: string[];
  entries: Record<string, unknown>;
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
  if (options.releaseId) validateReleaseId(options.releaseId);
  const layout = openClawLayout(options.openclawStateDir);
  const snapshot = await readConfigSnapshot(dependencies);
  return {
    ...(options.releaseId ? { releaseId: options.releaseId } : {}),
    configPatch: installConfigPatch(
      layout,
      snapshot.plugins,
      snapshot.allow,
      snapshot.entries,
      options,
    ),
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
    const configPatch = installConfigPatch(
      layout,
      snapshot.plugins,
      snapshot.allow,
      snapshot.entries,
      options,
    );
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
      await restoreConfigSnapshot(snapshot, dependencies).catch(
        () => undefined,
      );
      await extensionRestore?.restore().catch(() => undefined);
      await currentRestore.restore().catch(() => undefined);
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
    const configPatch = installConfigPatch(
      layout,
      snapshot.plugins,
      snapshot.allow,
      snapshot.entries,
      options,
    );
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
      await restoreConfigSnapshot(snapshot, dependencies).catch(
        () => undefined,
      );
      await extensionRestore?.restore().catch(() => undefined);
      await currentRestore.restore().catch(() => undefined);
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
  const layout = openClawLayout(options.openclawStateDir);
  await ensureInstallDirectories(layout);
  const releaseLock = await acquireInstallLock(layout);
  try {
    const snapshot = await readConfigSnapshot(dependencies);
    const configPatch = uninstallConfigPatch(
      snapshot.plugins,
      snapshot.allow,
      snapshot.entries,
    );
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
    [layout.configRoot, 0o700],
    [layout.stateRoot, 0o700],
  ] as const)
    await auditPath(path, mode, "directory", violations);
  await auditPath(layout.hostConfigPath, 0o600, "file", violations);
  await auditPath(layout.installManifestPath, 0o600, "file", violations);

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
  currentPlugins: Record<string, unknown>,
  currentAllow: string[],
  currentEntries: Record<string, unknown>,
  options: OpenClawPluginConfig,
): Record<string, unknown> {
  return {
    plugins: {
      ...currentPlugins,
      allow: currentAllow.includes(PLUGIN_ID)
        ? currentAllow
        : [...currentAllow, PLUGIN_ID],
      entries: {
        ...currentEntries,
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
      confirmationTtlMs: options.confirmationTtlMs ?? 300_000,
      maxRenderedChars: options.maxRenderedChars ?? 1_800,
      notificationPollMs: options.notificationPollMs ?? 2_000,
    },
  };
}

function uninstallConfigPatch(
  currentPlugins: Record<string, unknown>,
  currentAllow: string[],
  currentEntries: Record<string, unknown>,
): Record<string, unknown> {
  const entries = { ...currentEntries };
  const currentEntry = entries[PLUGIN_ID];
  if (
    currentEntry !== null &&
    typeof currentEntry === "object" &&
    !Array.isArray(currentEntry)
  )
    entries[PLUGIN_ID] = {
      ...(currentEntry as Record<string, unknown>),
      enabled: false,
    };
  return {
    plugins: {
      ...currentPlugins,
      allow: currentAllow.filter((id) => id !== PLUGIN_ID),
      entries,
    },
  };
}

async function readConfigSnapshot(
  dependencies: Pick<OpenClawLifecycleDependencies, "readConfigValue">,
): Promise<ConfigSnapshot> {
  const rawPlugins = await dependencies.readConfigValue("plugins");
  if (
    rawPlugins !== undefined &&
    (rawPlugins === null ||
      typeof rawPlugins !== "object" ||
      Array.isArray(rawPlugins))
  )
    throw new Error("OpenClaw plugins must be an object");
  const plugins =
    rawPlugins === undefined
      ? {}
      : { ...(rawPlugins as Record<string, unknown>) };
  const rawAllow = plugins.allow;
  const rawEntries = plugins.entries;
  if (
    rawAllow !== undefined &&
    (!Array.isArray(rawAllow) ||
      rawAllow.some((value) => typeof value !== "string" || !value))
  )
    throw new Error("OpenClaw plugins.allow must be an array of plugin ids");
  if (
    rawEntries !== undefined &&
    (rawEntries === null ||
      typeof rawEntries !== "object" ||
      Array.isArray(rawEntries))
  )
    throw new Error("OpenClaw plugins.entries must be an object");
  const entries =
    rawEntries === undefined
      ? {}
      : { ...(rawEntries as Record<string, unknown>) };
  return {
    plugins,
    allow: rawAllow === undefined ? [] : [...rawAllow],
    entries,
    entry: entries[PLUGIN_ID],
  };
}

async function restoreConfigSnapshot(
  snapshot: ConfigSnapshot,
  dependencies: OpenClawLifecycleDependencies,
): Promise<void> {
  await dependencies.replaceConfigValue("plugins.entries", snapshot.entries);
  await dependencies.applyConfigPatch(
    {
      plugins: { allow: snapshot.allow },
    },
    ["plugins.allow"],
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
    dirname(layout.extensionPath),
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
}

async function acquireInstallLock(
  layout: OpenClawInstallLayout,
): Promise<() => Promise<void>> {
  try {
    await mkdir(layout.lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Prime Dispatch OpenClaw lifecycle is already running");
    throw error;
  }
  return async () => await rm(layout.lockPath, { recursive: true });
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
  for (const relativePath of [
    "dist",
    "package.json",
    "pnpm-lock.yaml",
    "openclaw-plugin/dist",
    "openclaw-plugin/openclaw.plugin.json",
    "openclaw-plugin/package.json",
    "openclaw-plugin/pnpm-lock.yaml",
    "openclaw-plugin/pnpm-workspace.yaml",
    "openclaw-plugin/README.md",
  ])
    await digestPath(join(sourceRoot, relativePath), relativePath, hash);
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
    metadata?.releaseId === releaseId && metadata.sourceDigest === sourceDigest
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
  const destinationValue = HostConfigSchema.parse(JSON.parse(destinationRaw));
  return isDeepStrictEqual(sourceValue, destinationValue);
}

async function initializeState(
  source: string | undefined,
  layout: OpenClawInstallLayout,
): Promise<void> {
  if (await pathExists(layout.stateRoot)) return;
  if (!source) {
    await mkdir(layout.stateRoot, { mode: 0o700 });
    return;
  }
  const canonicalSource = await realpath(source);
  const sourceStat = await lstat(canonicalSource);
  if (!sourceStat.isDirectory())
    throw new Error("state source must be a directory");
  const staging = `${layout.stateRoot}.staging-${randomUUID()}`;
  try {
    await cp(canonicalSource, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    await secureTree(staging);
    await rename(staging, layout.stateRoot);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
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
  validateReleaseId(value.currentRelease);
  if (value.previousRelease) validateReleaseId(value.previousRelease);
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
  if (!RELEASE_ID_PATTERN.test(value) || value === "." || value === "..")
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
