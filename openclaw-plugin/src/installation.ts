import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024;

type Gate = {
  name: string;
  command: string;
  args: string[];
  timeoutMs: number;
};

export type NativeHostPolicy = {
  repoRoots: string[];
  multiChild?: false;
  repositories: Array<{
    path: string;
    fixture?: boolean;
    gates: Gate[];
  }>;
};

type NativePackageManifest = {
  schemaVersion: 2;
  variant: "online" | "offline";
  target: {
    platform: "darwin" | "linux";
    architecture: "arm64" | "x64";
    nodeVersion: string;
    openclawVersion: string;
  };
  prime:
    | { mode: "embedded"; path: string; sha256: string }
    | { mode: "download"; url: string; sha256: string };
};

export type InitializeNativePluginOptions = {
  pluginRoot: string;
  openclawStateDir: string;
  hostConfigPath: string;
  stateRoot: string;
  hostPolicy?: NativeHostPolicy;
};

export async function initializeNativePlugin(
  options: InitializeNativePluginOptions,
): Promise<void> {
  const pluginRoot = await realpath(options.pluginRoot);
  const manifest = parseManifest(
    JSON.parse(
      await readFile(join(pluginRoot, "prime-dispatch-package.json"), "utf8"),
    ),
  );
  await verifyTarget(pluginRoot, manifest);

  const managedRoot = join(options.openclawStateDir, "prime-dispatch");
  const runtimeRoot = join(managedRoot, "runtime");
  await ensurePrivateDirectory(managedRoot);
  await ensurePrivateDirectory(runtimeRoot);
  await ensurePrivateDirectory(dirname(options.hostConfigPath));
  await ensurePrivateDirectory(options.stateRoot);

  const runtimeArtifact = join(
    runtimeRoot,
    `sha256-${manifest.prime.sha256}.tgz`,
  );
  const existingRuntime = await lstat(runtimeArtifact).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (
    existingRuntime &&
    (!existingRuntime.isFile() || existingRuntime.isSymbolicLink())
  )
    throw new Error("Prime Dispatch managed runtime is not a regular file");
  if (
    (await sha256File(runtimeArtifact).catch(() => undefined)) !==
    manifest.prime.sha256
  ) {
    const temporary = join(runtimeRoot, `.prime-runtime.${randomUUID()}.tmp`);
    try {
      if (manifest.prime.mode === "embedded") {
        const source = await resolveContainedFile(
          pluginRoot,
          manifest.prime.path,
        );
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
      } else {
        await downloadRuntime(manifest.prime.url, temporary);
      }
      await chmod(temporary, 0o600);
      const actual = await sha256File(temporary);
      if (actual !== manifest.prime.sha256)
        throw new Error(
          `Prime runtime checksum mismatch: expected ${manifest.prime.sha256}, got ${actual}`,
        );
      await rename(temporary, runtimeArtifact);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await chmod(runtimeArtifact, 0o600);
  await installHostPolicy({
    path: options.hostConfigPath,
    runtimeArtifact,
    runtimeArtifactSha256: manifest.prime.sha256,
    ...(options.hostPolicy ? { hostPolicy: options.hostPolicy } : {}),
  });
}

function parseManifest(value: unknown): NativePackageManifest {
  if (!record(value) || value.schemaVersion !== 2)
    throw new Error("Prime Dispatch native package manifest is invalid");
  if (value.variant !== "online" && value.variant !== "offline")
    throw new Error("Prime Dispatch package variant is invalid");
  const target = value.target;
  const prime = value.prime;
  if (
    !record(target) ||
    (target.platform !== "darwin" && target.platform !== "linux") ||
    (target.architecture !== "arm64" && target.architecture !== "x64") ||
    typeof target.nodeVersion !== "string" ||
    typeof target.openclawVersion !== "string" ||
    !record(prime) ||
    (prime.mode !== "embedded" && prime.mode !== "download") ||
    typeof prime.sha256 !== "string" ||
    !SHA256_PATTERN.test(prime.sha256)
  )
    throw new Error("Prime Dispatch native package manifest is invalid");
  if (prime.mode === "embedded" && typeof prime.path !== "string")
    throw new Error("Prime Dispatch embedded runtime path is invalid");
  if (prime.mode === "download" && typeof prime.url !== "string")
    throw new Error("Prime Dispatch runtime URL is invalid");
  if ((value.variant === "offline") !== (prime.mode === "embedded"))
    throw new Error(
      "Prime Dispatch package variant and runtime source disagree",
    );
  return value as NativePackageManifest;
}

async function verifyTarget(
  pluginRoot: string,
  manifest: NativePackageManifest,
): Promise<void> {
  if (manifest.target.platform !== process.platform)
    throw new Error(
      `Prime Dispatch package requires ${manifest.target.platform}, got ${process.platform}`,
    );
  if (manifest.target.architecture !== process.arch)
    throw new Error(
      `Prime Dispatch package requires ${manifest.target.architecture}, got ${process.arch}`,
    );
  if (manifest.target.nodeVersion !== process.version)
    throw new Error(
      `Prime Dispatch package requires Node ${manifest.target.nodeVersion}, got ${process.version}`,
    );
  const openclawPackage = JSON.parse(
    await readFile(
      join(pluginRoot, "node_modules", "openclaw", "package.json"),
      "utf8",
    ),
  ) as { version?: unknown };
  if (openclawPackage.version !== manifest.target.openclawVersion)
    throw new Error(
      `Prime Dispatch package requires OpenClaw ${manifest.target.openclawVersion}, got ${String(openclawPackage.version)}`,
    );
}

async function installHostPolicy(options: {
  path: string;
  runtimeArtifact: string;
  runtimeArtifactSha256: string;
  hostPolicy?: NativeHostPolicy;
}): Promise<void> {
  const policy = options.hostPolicy ?? { repoRoots: [], repositories: [] };
  const next = {
    schemaVersion: 1,
    repoRoots: policy.repoRoots,
    ...(policy.multiChild === false ? { multiChild: false } : {}),
    repositories: policy.repositories,
    prime: {
      runtimeArtifact: options.runtimeArtifact,
      runtimeArtifactSha256: options.runtimeArtifactSha256,
    },
  };
  await atomicWriteJson(options.path, next);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`Prime Dispatch managed path is not a directory: ${path}`);
  await chmod(path, 0o700);
}

async function resolveContainedFile(
  root: string,
  value: string,
): Promise<string> {
  if (isAbsolute(value) || value.includes("\0"))
    throw new Error("Prime Dispatch embedded runtime path is unsafe");
  const candidate = await realpath(resolve(root, value));
  const path = relative(root, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error(
      "Prime Dispatch embedded runtime escapes the plugin package",
    );
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("Prime Dispatch embedded runtime is not a regular file");
  return candidate;
}

async function downloadRuntime(
  urlValue: string,
  destination: string,
): Promise<void> {
  const initialUrl = new URL(urlValue);
  validateRuntimeUrl(initialUrl);
  const signal = AbortSignal.timeout(300_000);
  let url = initialUrl;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetch(url, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirects === 3)
      throw new Error("Prime runtime download exceeded its redirect limit");
    const location = response.headers.get("location");
    if (!location)
      throw new Error("Prime runtime download redirect has no location");
    const target = new URL(location, url);
    validateRuntimeUrl(target);
    validateRuntimeRedirect(initialUrl, url, target);
    url = target;
  }
  if (!response || !response.ok || !response.body)
    throw new Error(
      `Prime runtime download failed with HTTP ${response?.status ?? "unknown"}`,
    );
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RUNTIME_BYTES)
    throw new Error("Prime runtime download exceeds its size limit");
  const handle = await open(destination, "wx", 0o600);
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_RUNTIME_BYTES)
        throw new Error("Prime runtime download exceeds its size limit");
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(
          chunk,
          offset,
          chunk.byteLength - offset,
        );
        if (bytesWritten <= 0)
          throw new Error("Prime runtime download made no write progress");
        offset += bytesWritten;
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateRuntimeUrl(url: URL): void {
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error(
      "Prime runtime download must use HTTPS (HTTP is allowed only for loopback acceptance)",
    );
  if (url.username || url.password)
    throw new Error("Prime runtime URL cannot contain credentials");
  if (url.protocol === "https:" && url.port && url.port !== "443")
    throw new Error("Prime runtime HTTPS URL must use the default port");
}

export function validateRuntimeRedirect(
  initialUrl: URL,
  sourceUrl: URL,
  targetUrl: URL,
): void {
  if (sourceUrl.origin === targetUrl.origin) return;
  if (
    initialUrl.protocol === "https:" &&
    initialUrl.hostname === "github.com" &&
    sourceUrl.hostname === "github.com" &&
    targetUrl.protocol === "https:" &&
    targetUrl.hostname === "release-assets.githubusercontent.com" &&
    !targetUrl.port
  )
    return;
  throw new Error(
    `Prime runtime download rejected redirect from ${sourceUrl.origin} to ${targetUrl.origin}`,
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
