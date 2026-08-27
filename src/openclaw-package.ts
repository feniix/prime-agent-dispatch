import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import canonicalize from "canonicalize";
import { c as createTar, t as listTar, x as extractTar } from "tar";
import { z } from "zod";
import { promisify } from "node:util";
import { HostConfigSchema } from "./host-config.js";
import {
  installOpenClaw,
  openClawLayout,
  type InstallOpenClawOptions,
  type OpenClawLifecycleDependencies,
} from "./openclaw-install.js";
import { preparePrimeRuntime } from "./prime-runtime-artifact.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_PACKAGE_ENTRIES = 400_000;
const MAX_PACKAGE_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
const MANIFEST_NAME = "prime-dispatch-package.json";
const PAYLOAD_ROOT = "payload";
const PRIME_RUNTIME_PATH = "payload/prime-runtime.tgz";
const execFileAsync = promisify(execFile);
const SOURCE_ENTRIES = [
  "dist",
  "package.json",
  "pnpm-lock.yaml",
  "openclaw-plugin/dist",
  "openclaw-plugin/openclaw.plugin.json",
  "openclaw-plugin/package.json",
  "openclaw-plugin/pnpm-lock.yaml",
  "openclaw-plugin/pnpm-workspace.yaml",
  "openclaw-plugin/README.md",
] as const;

const PackageEntrySchema = z
  .object({
    path: z.string().min(1).max(4_096),
    type: z.enum(["file", "directory", "symlink"]),
    mode: z.union([z.literal(0o644), z.literal(0o755), z.literal(0o777)]),
    size: z.number().int().nonnegative().max(MAX_PACKAGE_ENTRY_BYTES),
    sha256: z.string().regex(SHA256_PATTERN).optional(),
    target: z.string().min(1).max(4_096).optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.type === "file" && !entry.sha256)
      context.addIssue({
        code: "custom",
        message: "package file requires sha256",
      });
    if (entry.type !== "file" && entry.sha256)
      context.addIssue({
        code: "custom",
        message: "non-file package entry cannot have sha256",
      });
    if (entry.type === "symlink" && !entry.target)
      context.addIssue({
        code: "custom",
        message: "package symlink requires target",
      });
    if (entry.type !== "symlink" && entry.target)
      context.addIssue({
        code: "custom",
        message: "non-symlink package entry cannot have target",
      });
    if (
      entry.type === "directory" &&
      (entry.mode !== 0o755 || entry.size !== 0)
    )
      context.addIssue({
        code: "custom",
        message: "package directory metadata is invalid",
      });
    if (entry.type === "symlink" && (entry.mode !== 0o777 || entry.size !== 0))
      context.addIssue({
        code: "custom",
        message: "package symlink metadata is invalid",
      });
    if (entry.type === "file" && entry.mode !== 0o644 && entry.mode !== 0o755)
      context.addIssue({
        code: "custom",
        message: "package file mode is invalid",
      });
  });

const PrimeSourceSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("embedded"),
      path: z.literal(PRIME_RUNTIME_PATH),
      sha256: z.string().regex(SHA256_PATTERN),
    })
    .strict(),
  z
    .object({
      mode: z.literal("download"),
      url: z.string().url(),
      sha256: z.string().regex(SHA256_PATTERN),
    })
    .strict(),
]);

export const OpenClawPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    variant: z.enum(["online", "offline"]),
    releaseId: z.string().regex(RELEASE_ID_PATTERN),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    target: z
      .object({
        platform: z.enum(["darwin", "linux"]),
        architecture: z.enum(["arm64", "x64"]),
        nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
        openclawVersion: z.string().regex(/^\d{4}\.\d+\.\d+$/),
      })
      .strict(),
    prime: PrimeSourceSchema,
    entries: z.array(PackageEntrySchema).min(1).max(MAX_PACKAGE_ENTRIES),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      (manifest.variant === "offline") !==
      (manifest.prime.mode === "embedded")
    )
      context.addIssue({
        code: "custom",
        message: "package variant and Prime source disagree",
      });
    if (
      manifest.target.platform === "darwin" &&
      manifest.target.architecture !== "arm64"
    )
      context.addIssue({
        code: "custom",
        message: "supported Darwin target is arm64",
      });
    if (
      manifest.target.platform === "linux" &&
      manifest.target.architecture !== "x64"
    )
      context.addIssue({
        code: "custom",
        message: "supported Linux target is x64",
      });
    const names = manifest.entries.map((entry) => entry.path);
    if (new Set(names).size !== names.length)
      context.addIssue({
        code: "custom",
        message: "package manifest paths must be unique",
      });
    if (names.some((name, index) => index > 0 && names[index - 1]! >= name))
      context.addIssue({
        code: "custom",
        message: "package manifest paths must be sorted",
      });
    for (const entry of manifest.entries) {
      try {
        assertPackagePath(entry.path);
        if (
          entry.path !== PAYLOAD_ROOT &&
          !entry.path.startsWith(`${PAYLOAD_ROOT}/`)
        )
          throw new Error(`package entry is outside payload: ${entry.path}`);
      } catch (error) {
        context.addIssue({ code: "custom", message: errorMessage(error) });
      }
    }
    const byPath = new Map(
      manifest.entries.map((entry) => [entry.path, entry]),
    );
    if (byPath.get(PAYLOAD_ROOT)?.type !== "directory")
      context.addIssue({
        code: "custom",
        message: "package payload root is missing",
      });
    for (const required of SOURCE_ENTRIES)
      if (!byPath.has(`${PAYLOAD_ROOT}/${required}`))
        context.addIssue({
          code: "custom",
          message: `package source is missing ${required}`,
        });
    const hasCoreDependencies =
      byPath.get("payload/node_modules")?.type === "directory";
    const hasPluginDependencies =
      byPath.get("payload/openclaw-plugin/node_modules")?.type === "directory";
    if (
      manifest.variant === "offline" &&
      (!hasCoreDependencies || !hasPluginDependencies)
    )
      context.addIssue({
        code: "custom",
        message: "offline package requires vendored production dependencies",
      });
    if (
      manifest.variant === "online" &&
      (hasCoreDependencies || hasPluginDependencies)
    )
      context.addIssue({
        code: "custom",
        message: "online package cannot vendor production dependencies",
      });
    if (
      manifest.prime.mode === "embedded" &&
      byPath.get(manifest.prime.path)?.type !== "file"
    )
      context.addIssue({
        code: "custom",
        message: "embedded Prime runtime is missing",
      });
  });

export type OpenClawPackageManifest = z.infer<
  typeof OpenClawPackageManifestSchema
>;
type PackageEntry = z.infer<typeof PackageEntrySchema>;
type ArchiveEntry = {
  type: string;
  mode: number;
  size: number;
  target?: string;
};

export type BuildOpenClawPackageOptions = {
  variant: "online" | "offline";
  sourceRoot: string;
  sourceCommit: string;
  openclawVersion: string;
  releaseId: string;
  primeRuntimeArtifact: string;
  primeRuntimeSha256: string;
  primeRuntimeUrl?: string;
  output: string;
  installProductionDependencies?: (path: string) => Promise<void>;
};

export type InstallOpenClawPackageOptions = Omit<
  InstallOpenClawOptions,
  | "sourceRoot"
  | "hostConfigSource"
  | "releaseId"
  | "dependencyMode"
  | "primeRuntimeSource"
> & {
  packagePath: string;
  packageSha256: string;
  hostConfigSource: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return (
    value === "" ||
    (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
  );
}

function assertPackagePath(path: string): void {
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path !== posix.normalize(path) ||
    path === "." ||
    path.startsWith("../") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`unsafe package path: ${JSON.stringify(path)}`);
}

function assertSafeLink(entryPath: string, target: string): void {
  if (target.includes("\\") || target.includes("\0") || isAbsolute(target))
    throw new Error(`unsafe package symlink target: ${entryPath}`);
  const resolved = posix.normalize(
    posix.join(posix.dirname(entryPath), target),
  );
  if (resolved !== PAYLOAD_ROOT && !resolved.startsWith(`${PAYLOAD_ROOT}/`))
    throw new Error(`package symlink escapes payload: ${entryPath}`);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function canonicalManifest(manifest: OpenClawPackageManifest): string {
  const encoded = canonicalize(manifest);
  if (!encoded)
    throw new Error("OpenClaw package manifest could not be canonicalized");
  return `${encoded}\n`;
}

async function copySource(sourceRoot: string, payload: string): Promise<void> {
  for (const entry of SOURCE_ENTRIES) {
    const source = join(sourceRoot, ...entry.split("/"));
    const metadata = await lstat(source).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          throw new Error(`package source is missing ${entry}`);
        throw error;
      },
    );
    if (metadata.isSymbolicLink())
      throw new Error(`package source cannot be a symlink: ${entry}`);
    await cp(source, join(payload, ...entry.split("/")), {
      recursive: metadata.isDirectory(),
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
  }
}

async function installProductionDependencies(path: string): Promise<void> {
  await execFileAsync(
    "corepack",
    ["pnpm", "install", "--prod", "--frozen-lockfile"],
    {
      cwd: path,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    },
  );
}

async function normalizeTree(path: string, root: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    const target = await readlink(path);
    assertSafeLink(relative(root, path).split(sep).join("/"), target);
    const canonical = await realpath(path).catch(() => undefined);
    if (!canonical || !contained(root, canonical))
      throw new Error(`package source symlink escapes payload: ${path}`);
    return;
  }
  if (metadata.isDirectory()) {
    await chmod(path, 0o755);
    for (const child of (await readdir(path)).sort())
      await normalizeTree(join(path, child), root);
    return;
  }
  if (!metadata.isFile())
    throw new Error(`package source contains unsupported entry: ${path}`);
  await chmod(path, metadata.mode & 0o111 ? 0o755 : 0o644);
}

async function collectEntries(
  path: string,
  root: string,
  logicalPath: string,
): Promise<PackageEntry[]> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    const target = await readlink(path);
    assertSafeLink(logicalPath, target);
    const canonical = await realpath(path).catch(() => undefined);
    if (!canonical || !contained(root, canonical))
      throw new Error(`package symlink escapes payload: ${logicalPath}`);
    return [
      { path: logicalPath, type: "symlink", mode: 0o777, size: 0, target },
    ];
  }
  if (metadata.isDirectory()) {
    const entries: PackageEntry[] = [
      { path: logicalPath, type: "directory", mode: 0o755, size: 0 },
    ];
    for (const child of (await readdir(path)).sort())
      entries.push(
        ...(await collectEntries(
          join(path, child),
          root,
          `${logicalPath}/${child}`,
        )),
      );
    return entries;
  }
  if (!metadata.isFile())
    throw new Error(`package contains unsupported entry: ${logicalPath}`);
  if (metadata.size > MAX_PACKAGE_ENTRY_BYTES)
    throw new Error(`package entry is too large: ${logicalPath}`);
  return [
    {
      path: logicalPath,
      type: "file",
      mode: metadata.mode & 0o111 ? 0o755 : 0o644,
      size: metadata.size,
      sha256: await sha256File(path),
    },
  ];
}

export async function buildOpenClawPackage(
  options: BuildOpenClawPackageOptions,
): Promise<{
  artifactPath: string;
  artifactSha256: string;
  manifestSha256: string;
  manifest: OpenClawPackageManifest;
}> {
  if (!SHA256_PATTERN.test(options.primeRuntimeSha256))
    throw new Error("Prime runtime checksum is invalid");
  if (!RELEASE_ID_PATTERN.test(options.releaseId))
    throw new Error("release id is invalid");
  if (!/^[a-f0-9]{40}$/.test(options.sourceCommit))
    throw new Error("source commit must be a full Git SHA");
  if (options.variant === "online" && !options.primeRuntimeUrl)
    throw new Error("online package requires a Prime runtime URL");
  if (options.variant === "offline" && options.primeRuntimeUrl)
    throw new Error("offline package cannot declare a Prime runtime URL");
  const output = resolve(options.output);
  if (await lstat(output).catch(() => undefined))
    throw new Error(`OpenClaw package already exists: ${output}`);
  const sourceRoot = await realpath(options.sourceRoot);
  const primeRuntimeArtifact = await realpath(options.primeRuntimeArtifact);
  if ((await sha256File(primeRuntimeArtifact)) !== options.primeRuntimeSha256)
    throw new Error("Prime runtime checksum mismatch");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(
    join(dirname(output), ".openclaw-package-build-"),
  );
  await chmod(stage, 0o700);
  try {
    const verifiedRuntime = await preparePrimeRuntime({
      artifactPath: primeRuntimeArtifact,
      expectedArtifactSha256: options.primeRuntimeSha256,
      cacheDir: join(stage, "prime-verification"),
    });
    const publicationStage = join(stage, "publication");
    await mkdir(join(publicationStage, PAYLOAD_ROOT), {
      recursive: true,
      mode: 0o755,
    });
    const publication = await realpath(publicationStage);
    const payload = join(publication, PAYLOAD_ROOT);
    await copySource(sourceRoot, payload);
    if (options.variant === "offline") {
      const installDependencies =
        options.installProductionDependencies ?? installProductionDependencies;
      await installDependencies(payload);
      await installDependencies(join(payload, "openclaw-plugin"));
    }
    if (options.variant === "offline")
      await copyFile(
        primeRuntimeArtifact,
        join(publication, PRIME_RUNTIME_PATH),
        constants.COPYFILE_EXCL,
      );
    await normalizeTree(payload, publication);
    const entries = (await collectEntries(payload, payload, PAYLOAD_ROOT)).sort(
      (left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const manifest = OpenClawPackageManifestSchema.parse({
      schemaVersion: 1,
      variant: options.variant,
      releaseId: options.releaseId,
      sourceCommit: options.sourceCommit,
      target: {
        platform: verifiedRuntime.identity.platform,
        architecture: verifiedRuntime.identity.architecture,
        nodeVersion: verifiedRuntime.identity.nodeVersion,
        openclawVersion: options.openclawVersion,
      },
      prime:
        options.variant === "offline"
          ? {
              mode: "embedded",
              path: PRIME_RUNTIME_PATH,
              sha256: options.primeRuntimeSha256,
            }
          : {
              mode: "download",
              url: options.primeRuntimeUrl,
              sha256: options.primeRuntimeSha256,
            },
      entries,
    });
    const manifestText = canonicalManifest(manifest);
    const manifestPath = join(publication, MANIFEST_NAME);
    await writeFile(manifestPath, manifestText, { mode: 0o644, flag: "wx" });
    await chmod(manifestPath, 0o644);
    const temporaryArtifact = join(stage, "artifact.tgz");
    await createTar(
      {
        cwd: publication,
        file: temporaryArtifact,
        gzip: true,
        portable: true,
        noMtime: true,
        noDirRecurse: true,
        strict: true,
      },
      [MANIFEST_NAME, ...entries.map((entry) => entry.path)],
    );
    if ((await lstat(temporaryArtifact)).size > MAX_PACKAGE_BYTES)
      throw new Error("OpenClaw package exceeds its size limit");
    await copyFile(temporaryArtifact, output, constants.COPYFILE_EXCL);
    return {
      artifactPath: output,
      artifactSha256: await sha256File(output),
      manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
      manifest,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function normalizeArchivePath(path: string): string {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  assertPackagePath(normalized);
  return normalized;
}

async function inspectArchive(
  path: string,
): Promise<Map<string, ArchiveEntry>> {
  const entries = new Map<string, ArchiveEntry>();
  let totalBytes = 0;
  let violation: Error | undefined;
  await listTar({
    file: path,
    strict: true,
    onReadEntry: (entry) => {
      if (violation) return;
      try {
        const name = normalizeArchivePath(entry.path);
        if (entries.size >= MAX_PACKAGE_ENTRIES + 1)
          throw new Error("OpenClaw package contains too many entries");
        if (entries.has(name))
          throw new Error(`duplicate package archive entry: ${name}`);
        if (
          entry.type !== "File" &&
          entry.type !== "Directory" &&
          entry.type !== "SymbolicLink"
        )
          throw new Error(
            `unsupported package archive entry type ${entry.type}: ${name}`,
          );
        const size = entry.size ?? 0;
        if (size > MAX_PACKAGE_ENTRY_BYTES)
          throw new Error(`package archive entry is too large: ${name}`);
        totalBytes += size;
        if (totalBytes > MAX_PACKAGE_BYTES)
          throw new Error("OpenClaw package expands beyond its limit");
        if (
          (entry.uid !== undefined && entry.uid !== 0) ||
          (entry.gid !== undefined && entry.gid !== 0)
        )
          throw new Error(`package archive ownership surprise: ${name}`);
        const mode = (entry.mode ?? 0) & 0o777;
        const expectedMode =
          entry.type === "Directory"
            ? 0o755
            : entry.type === "SymbolicLink"
              ? 0o777
              : mode;
        if (entry.type === "File" && mode !== 0o644 && mode !== 0o755)
          throw new Error(
            `unsafe package archive mode for ${name}: ${mode.toString(8)}`,
          );
        if (entry.type === "Directory" && mode !== 0o755)
          throw new Error(
            `unsafe package archive mode for ${name}: ${mode.toString(8)}`,
          );
        const target =
          entry.type === "SymbolicLink" ? entry.linkpath : undefined;
        if (target) assertSafeLink(name, target);
        entries.set(name, {
          type: entry.type,
          mode: expectedMode,
          size,
          ...(target ? { target } : {}),
        });
      } catch (error) {
        violation = error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  if (violation) throw violation;
  return entries;
}

async function verifyPublication(
  publication: string,
  manifest: OpenClawPackageManifest,
  archiveEntries: Map<string, ArchiveEntry>,
): Promise<void> {
  const expectedNames = new Set([
    MANIFEST_NAME,
    ...manifest.entries.map((entry) => entry.path),
  ]);
  if (
    archiveEntries.size !== expectedNames.size ||
    [...archiveEntries.keys()].some((name) => !expectedNames.has(name))
  )
    throw new Error(
      "OpenClaw package contains missing, extra, or unmanifested content",
    );
  if (
    archiveEntries.get(MANIFEST_NAME)?.type !== "File" ||
    archiveEntries.get(MANIFEST_NAME)?.mode !== 0o644
  )
    throw new Error("OpenClaw package manifest metadata is invalid");
  const root = await realpath(publication);
  for (const entry of manifest.entries) {
    const archiveEntry = archiveEntries.get(entry.path);
    const expectedType =
      entry.type === "file"
        ? "File"
        : entry.type === "directory"
          ? "Directory"
          : "SymbolicLink";
    if (
      !archiveEntry ||
      archiveEntry.type !== expectedType ||
      archiveEntry.mode !== entry.mode ||
      archiveEntry.size !== entry.size ||
      archiveEntry.target !== entry.target
    )
      throw new Error(
        `OpenClaw package archive metadata mismatch: ${entry.path}`,
      );
    const path = join(publication, ...entry.path.split("/"));
    const metadata = await lstat(path);
    if (entry.type === "symlink") {
      if (!metadata.isSymbolicLink() || (await readlink(path)) !== entry.target)
        throw new Error(`OpenClaw package symlink mismatch: ${entry.path}`);
      const canonical = await realpath(path).catch(() => undefined);
      if (!canonical || !contained(root, canonical))
        throw new Error(
          `OpenClaw package symlink escaped publication: ${entry.path}`,
        );
      continue;
    }
    const canonical = await realpath(path);
    if (!contained(root, canonical))
      throw new Error(
        `OpenClaw package entry escaped publication: ${entry.path}`,
      );
    if (entry.type === "directory") {
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error(`OpenClaw package directory mismatch: ${entry.path}`);
    } else if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== entry.size ||
      (await sha256File(path)) !== entry.sha256
    ) {
      throw new Error(`OpenClaw package file mismatch: ${entry.path}`);
    }
    if ((metadata.mode & 0o777) !== entry.mode)
      throw new Error(`OpenClaw package mode mismatch: ${entry.path}`);
  }
}

function validateDownloadUrl(value: string): URL {
  const url = new URL(value);
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
  return url;
}

async function downloadPrimeRuntime(
  urlValue: string,
  destination: string,
  expectedSha256: string,
): Promise<void> {
  const url = validateDownloadUrl(urlValue);
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok || !response.body)
    throw new Error(
      `Prime runtime download failed with HTTP ${response.status}`,
    );
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_PACKAGE_ENTRY_BYTES)
    throw new Error("Prime runtime download exceeds its size limit");
  const handle = await open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_PACKAGE_ENTRY_BYTES)
        throw new Error("Prime runtime download exceeds its size limit");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(
          chunk,
          offset,
          chunk.byteLength - offset,
        );
        if (bytesWritten === 0)
          throw new Error("Prime runtime download write made no progress");
        offset += bytesWritten;
      }
    }
  } finally {
    await handle.close();
  }
  const actual = hash.digest("hex");
  if (actual !== expectedSha256)
    throw new Error(
      `Prime runtime download checksum mismatch: expected ${expectedSha256}, got ${actual}`,
    );
}

export async function installOpenClawPackage(
  options: InstallOpenClawPackageOptions,
  dependencies: OpenClawLifecycleDependencies,
): ReturnType<typeof installOpenClaw> {
  if (!SHA256_PATTERN.test(options.packageSha256))
    throw new Error("OpenClaw package checksum is invalid");
  const packagePath = await realpath(options.packagePath);
  const packageMetadata = await lstat(packagePath);
  if (
    !packageMetadata.isFile() ||
    packageMetadata.isSymbolicLink() ||
    packageMetadata.size > MAX_PACKAGE_BYTES
  )
    throw new Error("OpenClaw package must be a bounded regular file");
  const actualPackageSha256 = await sha256File(packagePath);
  if (actualPackageSha256 !== options.packageSha256)
    throw new Error(
      `OpenClaw package checksum mismatch: expected ${options.packageSha256}, got ${actualPackageSha256}`,
    );
  const archiveEntries = await inspectArchive(packagePath);
  const scratch = await mkdtemp(
    join(dirname(packagePath), ".openclaw-package-install-"),
  );
  await chmod(scratch, 0o700);
  try {
    await extractTar({
      cwd: scratch,
      file: packagePath,
      strict: true,
      preservePaths: false,
      unlink: false,
      chmod: true,
      processUmask: 0,
    });
    const manifestPath = join(scratch, MANIFEST_NAME);
    const manifestMetadata = await lstat(manifestPath);
    if (
      !manifestMetadata.isFile() ||
      manifestMetadata.isSymbolicLink() ||
      manifestMetadata.size > MAX_MANIFEST_BYTES
    )
      throw new Error(
        "OpenClaw package manifest is not a bounded regular file",
      );
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = OpenClawPackageManifestSchema.parse(
      JSON.parse(manifestRaw),
    );
    if (canonicalManifest(manifest) !== manifestRaw)
      throw new Error("OpenClaw package manifest is not canonical");
    await verifyPublication(scratch, manifest, archiveEntries);
    if (
      manifest.target.platform !== process.platform ||
      manifest.target.architecture !== process.arch ||
      manifest.target.nodeVersion !== process.version
    )
      throw new Error(
        `OpenClaw package target mismatch: requires ${manifest.target.platform}-${manifest.target.architecture} ${manifest.target.nodeVersion}, running ${process.platform}-${process.arch} ${process.version}`,
      );
    const openclawVersion = await dependencies.readOpenClawVersion();
    if (openclawVersion !== manifest.target.openclawVersion)
      throw new Error(
        `OpenClaw package version mismatch: requires ${manifest.target.openclawVersion}, running ${openclawVersion}`,
      );
    const primeRuntimeSource =
      manifest.prime.mode === "embedded"
        ? join(scratch, ...manifest.prime.path.split("/"))
        : join(scratch, `prime-runtime-${randomUUID()}.tgz`);
    if (manifest.prime.mode === "download")
      await downloadPrimeRuntime(
        manifest.prime.url,
        primeRuntimeSource,
        manifest.prime.sha256,
      );
    if ((await sha256File(primeRuntimeSource)) !== manifest.prime.sha256)
      throw new Error("managed Prime runtime checksum mismatch");
    const hostConfig = HostConfigSchema.parse(
      JSON.parse(
        await readFile(await realpath(options.hostConfigSource), "utf8"),
      ),
    );
    const layout = openClawLayout(options.openclawStateDir);
    const managedRuntimePath = join(layout.currentLink, "prime", "runtime.tgz");
    const managedHostConfigPath = join(scratch, "host.json");
    await writeFile(
      managedHostConfigPath,
      `${JSON.stringify({ ...hostConfig, prime: { runtimeArtifact: managedRuntimePath, runtimeArtifactSha256: manifest.prime.sha256 } }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return await installOpenClaw(
      {
        ...options,
        sourceRoot: join(scratch, PAYLOAD_ROOT),
        hostConfigSource: managedHostConfigPath,
        releaseId: manifest.releaseId,
        dependencyMode: manifest.variant === "offline" ? "vendored" : "install",
        primeRuntimeSource,
      },
      dependencies,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
