import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
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
import {
  PRIME_AGENT_COMMIT,
  PRIME_AGENT_SHA256,
  PRIME_AGENT_VERSION,
} from "./release.js";
import { runCommand } from "./process.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_RUNTIME_ENTRIES = 100_000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RUNTIME_ENTRY_BYTES = 1024 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 4 * 1024 * 1024 * 1024;
const RuntimeEntrySchema = z
  .object({
    path: z.string().min(1).max(4_096),
    type: z.enum(["file", "directory", "symlink"]),
    mode: z.union([z.literal(0o644), z.literal(0o755), z.literal(0o777)]),
    size: z.number().int().nonnegative().max(MAX_RUNTIME_ENTRY_BYTES).safe(),
    sha256: Sha256Schema.optional(),
    target: z.string().min(1).max(4_096).optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.type === "file" && !entry.sha256)
      context.addIssue({
        code: "custom",
        message: "runtime file requires sha256",
      });
    if (entry.type !== "file" && entry.sha256)
      context.addIssue({
        code: "custom",
        message: "non-file runtime entry cannot have sha256",
      });
    if (entry.type === "symlink" && !entry.target)
      context.addIssue({
        code: "custom",
        message: "runtime symlink requires target",
      });
    if (entry.type !== "symlink" && entry.target)
      context.addIssue({
        code: "custom",
        message: "non-symlink runtime entry cannot have target",
      });
    if (entry.type === "file" && entry.mode !== 0o644 && entry.mode !== 0o755)
      context.addIssue({
        code: "custom",
        message: "runtime file mode is invalid",
      });
    if (
      entry.type === "directory" &&
      (entry.mode !== 0o755 || entry.size !== 0)
    )
      context.addIssue({
        code: "custom",
        message: "runtime directory metadata is invalid",
      });
    if (entry.type === "symlink" && (entry.mode !== 0o777 || entry.size !== 0))
      context.addIssue({
        code: "custom",
        message: "runtime symlink metadata is invalid",
      });
  });

export const PrimeRuntimeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    primeVersion: z.literal(PRIME_AGENT_VERSION),
    primeCommit: z.literal(PRIME_AGENT_COMMIT),
    platform: z.string().min(1),
    architecture: z.string().min(1),
    nodeVersion: z.string().min(1),
    nodeExecutableSha256: Sha256Schema,
    lockfileSha256: Sha256Schema,
    officialReleaseSha256: Sha256Schema,
    entrypoint: z.string().min(1).max(4_096),
    entries: z.array(RuntimeEntrySchema).min(1).max(MAX_RUNTIME_ENTRIES),
  })
  .strict()
  .superRefine((manifest, context) => {
    try {
      assertRelativeRuntimePath(manifest.entrypoint);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["entrypoint"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const names = manifest.entries.map((entry) => entry.path);
    if (new Set(names).size !== names.length)
      context.addIssue({
        code: "custom",
        message: "runtime manifest paths must be unique",
      });
    if (names.some((name, index) => index > 0 && names[index - 1]! >= name))
      context.addIssue({
        code: "custom",
        message: "runtime manifest paths must be sorted",
      });
    const entrypoint = manifest.entries.find(
      (entry) => entry.path === manifest.entrypoint,
    );
    if (!entrypoint || entrypoint.type !== "file")
      context.addIssue({
        code: "custom",
        message: "runtime entrypoint must name a manifest file",
      });
    const byPath = new Map(
      manifest.entries.map((entry) => [entry.path, entry]),
    );
    if (
      manifest.entries.reduce((sum, entry) => sum + entry.size, 0) >
      MAX_RUNTIME_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "runtime manifest expands beyond its limit",
      });
    for (const entry of manifest.entries) {
      try {
        assertRelativeRuntimePath(entry.path);
        if (entry.target) assertRelativeRuntimePath(entry.target);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const parent = posix.dirname(entry.path);
      if (parent !== "." && byPath.get(parent)?.type !== "directory")
        context.addIssue({
          code: "custom",
          message: `runtime entry parent must be a manifest directory: ${entry.path}`,
        });
      if (entry.type !== "symlink") continue;
      const target = entry.target ? byPath.get(entry.target) : undefined;
      if (!target || target.type === "symlink")
        context.addIssue({
          code: "custom",
          message: `runtime symlink target must name a concrete manifest entry: ${entry.path}`,
        });
    }
  });
export type PrimeRuntimeManifest = z.infer<typeof PrimeRuntimeManifestSchema>;

export const PrimeRuntimeIdentitySchema = z
  .object({
    artifactSha256: Sha256Schema,
    manifestSha256: Sha256Schema,
    primeVersion: z.literal(PRIME_AGENT_VERSION),
    primeCommit: z.literal(PRIME_AGENT_COMMIT),
    platform: z.string().min(1),
    architecture: z.string().min(1),
    nodeVersion: z.string().min(1),
    nodeExecutableSha256: Sha256Schema,
    lockfileSha256: Sha256Schema,
    officialReleaseSha256: Sha256Schema,
    entrypointSha256: Sha256Schema,
  })
  .strict();
export type PrimeRuntimeIdentity = z.infer<typeof PrimeRuntimeIdentitySchema>;

type RuntimeEntry = z.infer<typeof RuntimeEntrySchema>;

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await import("node:fs").then(({ createReadStream }) =>
    createReadStream(path),
  );
  for await (const chunk of file) hash.update(chunk);
  return hash.digest("hex");
}

function canonicalManifest(manifest: PrimeRuntimeManifest): string {
  const encoded = canonicalize(manifest);
  if (!encoded)
    throw new Error("Prime runtime manifest could not be canonicalized");
  return `${encoded}\n`;
}

function assertRelativeRuntimePath(path: string): void {
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path !== posix.normalize(path) ||
    path === "." ||
    path.startsWith("../") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`unsafe Prime runtime path: ${JSON.stringify(path)}`);
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

async function materializeRuntime(
  sourceRoot: string,
  targetRoot: string,
): Promise<RuntimeEntry[]> {
  const canonicalRoot = await realpath(sourceRoot);
  const entries: RuntimeEntry[] = [];

  const visit = async (
    sourcePath: string,
    logicalPath: string,
  ): Promise<void> => {
    assertRelativeRuntimePath(logicalPath);
    const metadata = await lstat(sourcePath);
    const targetPath = join(targetRoot, ...logicalPath.split("/"));
    if (metadata.isSymbolicLink()) {
      const canonical = await realpath(sourcePath);
      if (!contained(canonicalRoot, canonical))
        throw new Error(
          `Prime runtime dependency resolves outside source: ${logicalPath}`,
        );
      const target = relative(canonicalRoot, canonical).split(sep).join("/");
      assertRelativeRuntimePath(target);
      entries.push({
        path: logicalPath,
        type: "symlink",
        mode: 0o777,
        size: 0,
        target,
      });
      return;
    }
    if (metadata.isDirectory()) {
      await mkdir(targetPath, { recursive: false, mode: 0o755 });
      entries.push({
        path: logicalPath,
        type: "directory",
        mode: 0o755,
        size: 0,
      });
      const children = (await readdir(sourcePath)).sort();
      for (const child of children)
        await visit(join(sourcePath, child), `${logicalPath}/${child}`);
      return;
    }
    if (!metadata.isFile())
      throw new Error(`unsupported Prime runtime source file: ${logicalPath}`);
    const mode = metadata.mode & 0o111 ? 0o755 : 0o644;
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, mode);
    entries.push({
      path: logicalPath,
      type: "file",
      mode,
      size: metadata.size,
      sha256: await sha256File(targetPath),
    });
  };

  for (const child of (await readdir(canonicalRoot)).sort())
    await visit(join(canonicalRoot, child), child);
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

async function verifyOfficialReleaseSource(
  releaseArtifact: string,
  sourceDir: string,
  stage: string,
): Promise<void> {
  const archiveEntries = await inspectArchive(releaseArtifact);
  if (archiveEntries.size === 0)
    throw new Error("official Prime release is empty");
  const releaseRoot = join(stage, "official-release");
  await mkdir(releaseRoot, { mode: 0o700 });
  await extractTar({
    cwd: releaseRoot,
    file: releaseArtifact,
    strict: true,
    preservePaths: false,
    unlink: false,
    chmod: true,
    processUmask: 0,
  });
  let matchedFiles = 0;
  for (const [archivePath, archiveEntry] of archiveEntries) {
    if (archivePath === "package" && archiveEntry.type === "Directory")
      continue;
    if (!archivePath.startsWith("package/"))
      throw new Error(
        `official Prime release entry is outside package/: ${archivePath}`,
      );
    const relativePath = archivePath.slice("package/".length);
    assertRelativeRuntimePath(relativePath);
    const sourcePath = join(sourceDir, ...relativePath.split("/"));
    const sourceMetadata = await lstat(sourcePath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (archiveEntry.type === "Directory") {
      if (!sourceMetadata?.isDirectory() || sourceMetadata.isSymbolicLink())
        throw new Error(
          `Prime source does not match official release directory: ${relativePath}`,
        );
      continue;
    }
    if (!sourceMetadata?.isFile() || sourceMetadata.isSymbolicLink())
      throw new Error(
        `Prime source does not match official release file: ${relativePath}`,
      );
    const releasePath = join(releaseRoot, ...archivePath.split("/"));
    if (
      sourceMetadata.size !== (await lstat(releasePath)).size ||
      (await sha256File(sourcePath)) !== (await sha256File(releasePath))
    )
      throw new Error(
        `Prime source was modified from official release: ${relativePath}`,
      );
    matchedFiles += 1;
  }
  if (matchedFiles === 0)
    throw new Error("official Prime release contains no files");
}

export async function buildPrimeRuntimeArtifact(options: {
  sourceDir: string;
  releaseArtifact: string;
  lockfile: string;
  output: string;
  entrypoint: string;
  primeVersion: typeof PRIME_AGENT_VERSION;
  primeCommit: typeof PRIME_AGENT_COMMIT;
  platform?: string;
  architecture?: string;
  nodeVersion?: string;
  nodeExecutable?: string;
  expectedOfficialReleaseSha256?: string;
}): Promise<{
  artifactPath: string;
  artifactSha256: string;
  manifestSha256: string;
  manifest: PrimeRuntimeManifest;
}> {
  assertRelativeRuntimePath(options.entrypoint);
  const output = resolve(options.output);
  await lstat(output)
    .then(() => {
      throw new Error(`Prime runtime artifact already exists: ${output}`);
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(dirname(output), ".prime-runtime-build-"));
  await chmod(stage, 0o700);
  try {
    const nodeExecutable = options.nodeExecutable ?? process.execPath;
    const officialReleaseMetadata = await lstat(options.releaseArtifact);
    if (
      !officialReleaseMetadata.isFile() ||
      officialReleaseMetadata.isSymbolicLink() ||
      officialReleaseMetadata.size > MAX_ARTIFACT_BYTES
    )
      throw new Error("official Prime release is not a bounded regular file");
    const officialReleaseSha256 = await sha256File(options.releaseArtifact);
    const expectedOfficialReleaseSha256 =
      options.expectedOfficialReleaseSha256 ?? PRIME_AGENT_SHA256;
    if (officialReleaseSha256 !== expectedOfficialReleaseSha256)
      throw new Error(
        `official Prime release checksum mismatch: expected ${expectedOfficialReleaseSha256}, got ${officialReleaseSha256}`,
      );
    await verifyOfficialReleaseSource(
      options.releaseArtifact,
      options.sourceDir,
      stage,
    );
    const sourcePackage = JSON.parse(
      await readFile(join(options.sourceDir, "package.json"), "utf8"),
    ) as { version?: unknown };
    if (sourcePackage.version !== options.primeVersion)
      throw new Error(
        `Prime source version mismatch: expected ${options.primeVersion}, got ${String(sourcePackage.version)}`,
      );
    const publication = join(stage, "publication");
    const runtime = join(publication, "runtime");
    await mkdir(runtime, { recursive: true, mode: 0o755 });
    const entries = await materializeRuntime(options.sourceDir, runtime);
    const manifest = PrimeRuntimeManifestSchema.parse({
      schemaVersion: 1,
      primeVersion: options.primeVersion,
      primeCommit: options.primeCommit,
      platform: options.platform ?? process.platform,
      architecture: options.architecture ?? process.arch,
      nodeVersion: options.nodeVersion ?? process.version,
      nodeExecutableSha256: await sha256File(nodeExecutable),
      lockfileSha256: await sha256File(options.lockfile),
      officialReleaseSha256,
      entrypoint: options.entrypoint,
      entries,
    });
    const manifestText = canonicalManifest(manifest);
    const manifestPath = join(publication, "prime-runtime-manifest.json");
    await writeFile(manifestPath, manifestText, { mode: 0o644, flag: "wx" });
    const manifestSha256 = createHash("sha256")
      .update(manifestText)
      .digest("hex");
    const temporaryArtifact = join(stage, "artifact.tgz");
    const archivePaths = [
      "prime-runtime-manifest.json",
      "runtime",
      ...entries
        .filter((entry) => entry.type !== "symlink")
        .map((entry) => `runtime/${entry.path}`),
    ];
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
      archivePaths,
    );
    if ((await lstat(temporaryArtifact)).size > MAX_ARTIFACT_BYTES)
      throw new Error("Prime runtime artifact exceeds its size limit");
    await copyFile(
      temporaryArtifact,
      output,
      (await import("node:fs")).constants.COPYFILE_EXCL,
    );
    return {
      artifactPath: output,
      artifactSha256: await sha256File(output),
      manifestSha256,
      manifest,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function normalizeArchivePath(path: string): string {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  assertRelativeRuntimePath(normalized);
  return normalized;
}

async function inspectArchive(
  path: string,
): Promise<Map<string, { type: string; mode: number }>> {
  const entries = new Map<string, { type: string; mode: number }>();
  let totalBytes = 0;
  let violation: Error | undefined;
  await listTar({
    file: path,
    strict: true,
    onReadEntry: (entry) => {
      if (violation) return;
      try {
        const name = normalizeArchivePath(entry.path);
        if (entries.size >= MAX_RUNTIME_ENTRIES + 2)
          throw new Error("Prime runtime archive contains too many entries");
        if (entries.has(name))
          throw new Error(`duplicate archive entry: ${name}`);
        if (entry.type !== "File" && entry.type !== "Directory")
          throw new Error(
            `unsupported archive entry type ${entry.type}: links are forbidden`,
          );
        const size = entry.size ?? 0;
        if (size > MAX_RUNTIME_ENTRY_BYTES)
          throw new Error(`archive entry is too large: ${name}`);
        totalBytes += size;
        if (totalBytes > MAX_RUNTIME_BYTES)
          throw new Error("Prime runtime archive expands beyond its limit");
        if (
          (entry.uid !== undefined && entry.uid !== 0) ||
          (entry.gid !== undefined && entry.gid !== 0)
        )
          throw new Error(`archive ownership surprise: ${name}`);
        const mode = (entry.mode ?? 0) & 0o777;
        if (mode !== 0o644 && mode !== 0o755)
          throw new Error(
            `unsafe archive mode for ${name}: ${mode.toString(8)}`,
          );
        entries.set(name, { type: entry.type, mode });
      } catch (error) {
        violation = error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  if (violation) throw violation;
  return entries;
}

async function verifyPublishedRuntime(
  publication: string,
  manifest: PrimeRuntimeManifest,
  archiveEntries: Map<string, { type: string; mode: number }>,
  allowLinkCreation: boolean,
): Promise<void> {
  const expected = new Map<string, RuntimeEntry>(
    manifest.entries
      .filter((entry) => entry.type !== "symlink")
      .map((entry) => [`runtime/${entry.path}`, entry]),
  );
  const expectedArchiveNames = new Set([
    "prime-runtime-manifest.json",
    "runtime",
    ...expected.keys(),
  ]);
  if (
    archiveEntries.size !== expectedArchiveNames.size ||
    [...archiveEntries.keys()].some((name) => !expectedArchiveNames.has(name))
  )
    throw new Error(
      "Prime runtime archive contains missing, extra, or unmanifested content",
    );
  if (
    archiveEntries.get("prime-runtime-manifest.json")?.type !== "File" ||
    archiveEntries.get("prime-runtime-manifest.json")?.mode !== 0o644 ||
    archiveEntries.get("runtime")?.type !== "Directory" ||
    archiveEntries.get("runtime")?.mode !== 0o755
  )
    throw new Error("Prime runtime archive roots have invalid metadata");
  const manifestMetadata = await lstat(
    join(publication, "prime-runtime-manifest.json"),
  );
  const runtimeMetadata = await lstat(join(publication, "runtime"));
  if (
    !manifestMetadata.isFile() ||
    manifestMetadata.isSymbolicLink() ||
    (manifestMetadata.mode & 0o777) !== 0o644 ||
    !runtimeMetadata.isDirectory() ||
    runtimeMetadata.isSymbolicLink() ||
    (runtimeMetadata.mode & 0o777) !== 0o755
  )
    throw new Error("published Prime runtime roots have invalid metadata");
  const canonicalPublication = await realpath(publication);
  for (const [archivePath, entry] of expected) {
    const path = join(publication, ...archivePath.split("/"));
    const metadata = await lstat(path);
    const canonical = await realpath(path);
    if (!contained(canonicalPublication, canonical))
      throw new Error(`Prime runtime entry escaped publication: ${entry.path}`);
    if (entry.type === "directory") {
      if (!metadata.isDirectory())
        throw new Error(`Prime runtime directory is missing: ${entry.path}`);
    } else {
      if (!metadata.isFile())
        throw new Error(`Prime runtime file is missing: ${entry.path}`);
      if (
        metadata.size !== entry.size ||
        (await sha256File(path)) !== entry.sha256
      )
        throw new Error(`Prime runtime file was modified: ${entry.path}`);
    }
    if ((metadata.mode & 0o777) !== entry.mode)
      throw new Error(`Prime runtime mode mismatch: ${entry.path}`);
  }
  const runtimeRoot = join(publication, "runtime");
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  for (const entry of manifest.entries) {
    if (entry.type !== "symlink") continue;
    const target = byPath.get(entry.target!);
    if (!target || target.type === "symlink")
      throw new Error(`Prime runtime link target is invalid: ${entry.path}`);
    const linkPath = join(runtimeRoot, ...entry.path.split("/"));
    const targetPath = join(runtimeRoot, ...entry.target!.split("/"));
    const expectedLink = relative(dirname(linkPath), targetPath);
    let metadata = await lstat(linkPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!metadata) {
      if (!allowLinkCreation)
        throw new Error(`Prime runtime link is missing: ${entry.path}`);
      await symlink(
        expectedLink,
        linkPath,
        target.type === "directory" ? "dir" : "file",
      );
      metadata = await lstat(linkPath);
    }
    if (!metadata.isSymbolicLink())
      throw new Error(`Prime runtime link was replaced: ${entry.path}`);
    if ((await readlink(linkPath)) !== expectedLink)
      throw new Error(`Prime runtime link target mismatch: ${entry.path}`);
    const canonical = await realpath(linkPath);
    if (
      canonical !== (await realpath(targetPath)) ||
      !contained(canonicalPublication, canonical)
    )
      throw new Error(`Prime runtime link escaped publication: ${entry.path}`);
  }
  const actualNames = new Set<string>();
  const visit = async (
    directory: string,
    logicalDirectory: string,
  ): Promise<void> => {
    for (const name of await readdir(directory)) {
      const logicalPath = logicalDirectory
        ? `${logicalDirectory}/${name}`
        : name;
      assertRelativeRuntimePath(logicalPath);
      if (actualNames.size >= MAX_RUNTIME_ENTRIES + 2)
        throw new Error("published Prime runtime contains too many entries");
      actualNames.add(logicalPath);
      const child = join(directory, name);
      const metadata = await lstat(child);
      if (metadata.isDirectory()) await visit(child, logicalPath);
      else if (!metadata.isFile() && !metadata.isSymbolicLink())
        throw new Error(
          `published Prime runtime contains a special file: ${logicalPath}`,
        );
    }
  };
  await visit(publication, "");
  const expectedPublishedNames = new Set([
    "prime-runtime-manifest.json",
    "runtime",
    ...manifest.entries.map((entry) => `runtime/${entry.path}`),
  ]);
  if (
    actualNames.size !== expectedPublishedNames.size ||
    [...actualNames].some((name) => !expectedPublishedNames.has(name))
  )
    throw new Error(
      "published Prime runtime contains missing, extra, or unmanifested content",
    );
}

async function validatePrimeRuntimeStartup(
  executablePath: string,
  manifest: PrimeRuntimeManifest,
  options: {
    nodeExecutable?: string;
    signal?: AbortSignal;
    terminationGraceMs?: number;
  },
  validationHome: string,
): Promise<void> {
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const environment = {
    HOME: validationHome,
    NODE_PATH: "",
    PATH: `${dirname(nodeExecutable)}:/usr/bin:/bin`,
  };
  const control = {
    env: environment,
    timeoutMs: 10_000,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.terminationGraceMs !== undefined
      ? { terminationGraceMs: options.terminationGraceMs }
      : {}),
  };
  const version = await runCommand(
    nodeExecutable,
    [executablePath, "--version"],
    { ...control, maxOutputBytes: 4_096 },
  );
  const reportedVersion = (version.stdout || version.stderr).trim();
  if (version.exitCode !== 0 || reportedVersion !== manifest.primeVersion)
    throw new Error(
      `Prime runtime version mismatch: expected ${manifest.primeVersion}, got ${reportedVersion || "no version"}`,
    );
  const help = await runCommand(nodeExecutable, [executablePath, "--help"], {
    ...control,
    maxOutputBytes: 64 * 1024,
  });
  if (help.exitCode !== 0 || !(help.stdout || help.stderr).trim())
    throw new Error("Prime runtime help startup failed");
}

export async function preparePrimeRuntime(options: {
  artifactPath: string;
  expectedArtifactSha256: string;
  cacheDir: string;
  platform?: string;
  architecture?: string;
  nodeVersion?: string;
  nodeExecutable?: string;
  signal?: AbortSignal;
  terminationGraceMs?: number;
}): Promise<{
  executablePath: string;
  runtimeRoot: string;
  identity: PrimeRuntimeIdentity;
}> {
  const expectedArtifactSha256 = Sha256Schema.parse(
    options.expectedArtifactSha256,
  );
  const cacheDir = resolve(options.cacheDir);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const cacheMetadata = await lstat(cacheDir);
  if (!cacheMetadata.isDirectory() || cacheMetadata.isSymbolicLink())
    throw new Error("Prime runtime cache must be a real directory");
  await chmod(cacheDir, 0o700);
  const canonicalCacheDir = await realpath(cacheDir);
  const stage = await mkdtemp(join(cacheDir, ".prime-runtime-verify-"));
  await chmod(stage, 0o700);
  try {
    const sourceArtifactMetadata = await lstat(options.artifactPath);
    if (
      !sourceArtifactMetadata.isFile() ||
      sourceArtifactMetadata.isSymbolicLink() ||
      sourceArtifactMetadata.size > MAX_ARTIFACT_BYTES
    )
      throw new Error("Prime runtime artifact is not a bounded regular file");
    const privateArtifact = join(stage, "artifact.tgz");
    await copyFile(
      options.artifactPath,
      privateArtifact,
      (await import("node:fs")).constants.COPYFILE_EXCL,
    );
    await chmod(privateArtifact, 0o600);
    const artifactMetadata = await lstat(privateArtifact);
    if (
      !artifactMetadata.isFile() ||
      artifactMetadata.size > MAX_ARTIFACT_BYTES
    )
      throw new Error("Prime runtime artifact is not a bounded regular file");
    const artifactSha256 = await sha256File(privateArtifact);
    if (artifactSha256 !== expectedArtifactSha256)
      throw new Error(
        `Prime runtime artifact checksum mismatch: expected ${expectedArtifactSha256}, got ${artifactSha256}`,
      );
    const archiveEntries = await inspectArchive(privateArtifact);
    const publication = join(stage, "publication");
    await mkdir(publication, { mode: 0o700 });
    await extractTar({
      cwd: publication,
      file: privateArtifact,
      strict: true,
      preservePaths: false,
      unlink: false,
      chmod: true,
      processUmask: 0,
    });
    const manifestPath = join(publication, "prime-runtime-manifest.json");
    const manifestMetadata = await lstat(manifestPath);
    if (
      !manifestMetadata.isFile() ||
      manifestMetadata.size > MAX_MANIFEST_BYTES
    )
      throw new Error("Prime runtime manifest is not a bounded regular file");
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = PrimeRuntimeManifestSchema.parse(JSON.parse(manifestText));
    if (manifestText !== canonicalManifest(manifest))
      throw new Error("Prime runtime manifest is not canonical");
    const platform = options.platform ?? process.platform;
    const architecture = options.architecture ?? process.arch;
    const nodeVersion = options.nodeVersion ?? process.version;
    if (manifest.platform !== platform)
      throw new Error(
        `Prime runtime platform mismatch: expected ${platform}, got ${manifest.platform}`,
      );
    if (manifest.architecture !== architecture)
      throw new Error(
        `Prime runtime architecture mismatch: expected ${architecture}, got ${manifest.architecture}`,
      );
    if (manifest.nodeVersion !== nodeVersion)
      throw new Error(
        `Prime runtime Node version mismatch: expected ${nodeVersion}, got ${manifest.nodeVersion}`,
      );
    const nodeExecutableSha256 = await sha256File(
      options.nodeExecutable ?? process.execPath,
    );
    if (manifest.nodeExecutableSha256 !== nodeExecutableSha256)
      throw new Error("Prime runtime Node executable mismatch");
    await verifyPublishedRuntime(publication, manifest, archiveEntries, true);
    const manifestSha256 = createHash("sha256")
      .update(manifestText)
      .digest("hex");
    const entrypoint = manifest.entries.find(
      (entry) => entry.path === manifest.entrypoint,
    )!;
    const identity = PrimeRuntimeIdentitySchema.parse({
      artifactSha256,
      manifestSha256,
      primeVersion: manifest.primeVersion,
      primeCommit: manifest.primeCommit,
      platform: manifest.platform,
      architecture: manifest.architecture,
      nodeVersion: manifest.nodeVersion,
      nodeExecutableSha256,
      lockfileSha256: manifest.lockfileSha256,
      officialReleaseSha256: manifest.officialReleaseSha256,
      entrypointSha256: entrypoint.sha256,
    });
    const stagedExecutablePath = join(
      publication,
      "runtime",
      ...manifest.entrypoint.split("/"),
    );
    const validationHome = join(stage, "validation-home");
    await mkdir(validationHome, { mode: 0o700 });
    await validatePrimeRuntimeStartup(
      stagedExecutablePath,
      manifest,
      options,
      validationHome,
    );
    const target = join(cacheDir, `sha256-${artifactSha256}`);
    const verifyExistingTarget = async (): Promise<void> => {
      const metadata = await lstat(target);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("pre-existing Prime runtime cache target is unsafe");
      const canonicalTarget = await realpath(target);
      if (dirname(canonicalTarget) !== canonicalCacheDir)
        throw new Error(
          "pre-existing Prime runtime cache target escaped cache",
        );
      const existingManifestText = await readFile(
        join(target, "prime-runtime-manifest.json"),
        "utf8",
      );
      const existingManifest = PrimeRuntimeManifestSchema.parse(
        JSON.parse(existingManifestText),
      );
      if (existingManifestText !== manifestText)
        throw new Error(
          "pre-existing Prime runtime cache target has different identity",
        );
      await verifyPublishedRuntime(
        target,
        existingManifest,
        archiveEntries,
        false,
      );
      if (dirname(await realpath(target)) !== canonicalCacheDir)
        throw new Error("pre-existing Prime runtime cache target changed");
    };
    const existing = await lstat(target).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (existing) {
      await verifyExistingTarget();
    } else {
      try {
        await rename(publication, target);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" &&
          (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
        )
          throw error;
        await verifyExistingTarget();
      }
    }
    const executablePath = join(
      target,
      "runtime",
      ...manifest.entrypoint.split("/"),
    );
    return { executablePath, runtimeRoot: join(target, "runtime"), identity };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
