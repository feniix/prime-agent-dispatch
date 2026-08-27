import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
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
import { promisify } from "node:util";
import canonicalize from "canonicalize";
import { c as createTar } from "tar";
import { z } from "zod";
import { preparePrimeRuntime } from "./prime-runtime-artifact.js";

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MANIFEST_NAME = "prime-dispatch-package.json";
const EMBEDDED_RUNTIME_PATH = "prime/runtime.tgz";
const MAX_ENTRIES = 400_000;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

const EntrySchema = z
  .object({
    path: z.string().min(1).max(4_096),
    type: z.enum(["file", "directory"]),
    mode: z.union([z.literal(0o644), z.literal(0o755), z.literal(0o777)]),
    size: z.number().int().nonnegative().max(MAX_ENTRY_BYTES),
    sha256: z.string().regex(SHA256_PATTERN).optional(),
    target: z.string().min(1).max(4_096).optional(),
  })
  .strict();

const PrimeSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("embedded"),
      path: z.literal(EMBEDDED_RUNTIME_PATH),
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

export const NativeOpenClawPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
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
    prime: PrimeSchema,
    entries: z.array(EntrySchema).min(1).max(MAX_ENTRIES),
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
    if (
      manifest.entries.reduce((total, entry) => total + entry.size, 0) >
      MAX_UNPACKED_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "native plugin exceeds OpenClaw's unpacked size limit",
      });
    for (const required of [
      "README.md",
      "dist",
      "openclaw.plugin.json",
      "package.json",
      "runtime",
    ])
      if (!names.includes(required))
        context.addIssue({
          code: "custom",
          message: `native plugin package is missing ${required}`,
        });
    const hasDependencies = names.includes("node_modules");
    const hasRuntimeDependencies = names.includes("runtime/node_modules");
    if (
      manifest.variant === "offline" &&
      (!hasDependencies || !hasRuntimeDependencies)
    )
      context.addIssue({
        code: "custom",
        message: "offline plugin requires vendored production dependencies",
      });
    if (
      manifest.variant === "online" &&
      (hasDependencies || hasRuntimeDependencies)
    )
      context.addIssue({
        code: "custom",
        message: "online plugin cannot vendor production dependencies",
      });
    if (
      manifest.prime.mode === "embedded" &&
      !names.includes(manifest.prime.path)
    )
      context.addIssue({
        code: "custom",
        message: "offline plugin is missing its Prime runtime",
      });
  });

export type NativeOpenClawPackageManifest = z.infer<
  typeof NativeOpenClawPackageManifestSchema
>;
type PackageEntry = z.infer<typeof EntrySchema>;

export type BuildNativeOpenClawPluginPackageOptions = {
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

export async function buildNativeOpenClawPluginPackage(
  options: BuildNativeOpenClawPluginPackageOptions,
): Promise<{
  artifactPath: string;
  artifactSha256: string;
  manifestSha256: string;
  manifest: NativeOpenClawPackageManifest;
}> {
  validateBuildOptions(options);
  const output = resolve(options.output);
  if (await lstat(output).catch(() => undefined))
    throw new Error(`OpenClaw plugin package already exists: ${output}`);
  const sourceRoot = await realpath(options.sourceRoot);
  const primeRuntime = await realpath(options.primeRuntimeArtifact);
  if ((await sha256File(primeRuntime)) !== options.primeRuntimeSha256)
    throw new Error("Prime runtime checksum mismatch");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(dirname(output), ".native-plugin-build-"));
  await chmod(stage, 0o700);
  try {
    const verifiedRuntime = await preparePrimeRuntime({
      artifactPath: primeRuntime,
      expectedArtifactSha256: options.primeRuntimeSha256,
      cacheDir: join(stage, "prime-verification"),
    });
    const publicationPath = join(stage, "publication");
    await mkdir(publicationPath, { mode: 0o755 });
    const publication = await realpath(publicationPath);
    await copyPluginSources(sourceRoot, publication);
    await writePackageJson({
      sourceRoot,
      publication,
      variant: options.variant,
      openclawVersion: options.openclawVersion,
    });
    if (options.variant === "offline") {
      await vendorDependencies(
        sourceRoot,
        publication,
        options.installProductionDependencies ?? installProductionDependencies,
      );
      await mkdir(join(publication, "prime"), { mode: 0o755 });
      await copyFile(
        primeRuntime,
        join(publication, EMBEDDED_RUNTIME_PATH),
        constants.COPYFILE_EXCL,
      );
    }
    await normalizeTree(publication);
    const entries = (await collectChildren(publication, publication)).sort(
      compareEntries,
    );
    const manifest = NativeOpenClawPackageManifestSchema.parse({
      schemaVersion: 2,
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
              path: EMBEDDED_RUNTIME_PATH,
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
    await writeFile(join(publication, MANIFEST_NAME), manifestText, {
      mode: 0o644,
      flag: "wx",
    });
    await chmod(join(publication, MANIFEST_NAME), 0o644);
    const artifact = join(stage, "artifact.tgz");
    await createTar(
      {
        cwd: publication,
        file: artifact,
        gzip: true,
        portable: true,
        noMtime: true,
        noDirRecurse: true,
        strict: true,
      },
      [MANIFEST_NAME, ...entries.map((entry) => entry.path)],
    );
    if ((await lstat(artifact)).size > MAX_PACKAGE_BYTES)
      throw new Error("OpenClaw plugin package exceeds its size limit");
    await copyFile(artifact, output, constants.COPYFILE_EXCL);
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

function validateBuildOptions(
  options: BuildNativeOpenClawPluginPackageOptions,
): void {
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
}

async function copyPluginSources(
  sourceRoot: string,
  publication: string,
): Promise<void> {
  const copies = [
    ["openclaw-plugin/dist", "dist"],
    ["openclaw-plugin/openclaw.plugin.json", "openclaw.plugin.json"],
    ["openclaw-plugin/README.md", "README.md"],
    ["dist", "runtime/dist"],
  ] as const;
  for (const [sourceName, destinationName] of copies) {
    const source = join(sourceRoot, ...sourceName.split("/"));
    const metadata = await lstat(source).catch(() => undefined);
    if (!metadata || metadata.isSymbolicLink())
      throw new Error(`native plugin source is missing ${sourceName}`);
    await cp(source, join(publication, ...destinationName.split("/")), {
      recursive: metadata.isDirectory(),
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
  }
  const corePackage = JSON.parse(
    await readFile(join(sourceRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  await writeFile(
    join(publication, "runtime", "package.json"),
    `${JSON.stringify(
      {
        name: "prime-dispatch-runtime",
        version: corePackage.version,
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
    { mode: 0o644, flag: "wx" },
  );
}

async function writePackageJson(options: {
  sourceRoot: string;
  publication: string;
  variant: "online" | "offline";
  openclawVersion: string;
}): Promise<void> {
  const pluginPackage = JSON.parse(
    await readFile(
      join(options.sourceRoot, "openclaw-plugin", "package.json"),
      "utf8",
    ),
  ) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
  };
  const corePackage = JSON.parse(
    await readFile(join(options.sourceRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const dependencies = {
    ...(corePackage.dependencies ?? {}),
    ...(pluginPackage.dependencies ?? {}),
  };
  await writeFile(
    join(options.publication, "package.json"),
    `${JSON.stringify(
      {
        name: pluginPackage.name,
        version: pluginPackage.version,
        description: "Prime Dispatch for OpenClaw",
        type: "module",
        engines: { node: process.version.slice(1) },
        dependencies: options.variant === "online" ? dependencies : {},
        peerDependencies: { openclaw: options.openclawVersion },
        peerDependenciesMeta: { openclaw: { optional: true } },
        openclaw: { extensions: ["./dist/index.js"] },
      },
      null,
      2,
    )}\n`,
    { mode: 0o644, flag: "wx" },
  );
}

async function vendorDependencies(
  sourceRoot: string,
  publication: string,
  installDependencies: (path: string) => Promise<void>,
): Promise<void> {
  const runtime = join(publication, "runtime");
  const finalPluginPackage = await readFile(
    join(publication, "package.json"),
    "utf8",
  );
  const finalRuntimePackage = await readFile(
    join(runtime, "package.json"),
    "utf8",
  );
  await copyFile(
    join(sourceRoot, "package.json"),
    join(runtime, "package.json"),
  );
  await copyFile(
    join(sourceRoot, "pnpm-lock.yaml"),
    join(runtime, "pnpm-lock.yaml"),
  );
  await disableAutoInstallPeers(join(runtime, "pnpm-lock.yaml"));
  await installDependencies(runtime);
  await removeBinDirectories(join(runtime, "node_modules"));
  await copyFile(
    join(sourceRoot, "openclaw-plugin", "package.json"),
    join(publication, "package.json"),
  );
  await copyFile(
    join(sourceRoot, "openclaw-plugin", "pnpm-lock.yaml"),
    join(publication, "pnpm-lock.yaml"),
  );
  await disableAutoInstallPeers(join(publication, "pnpm-lock.yaml"));
  await copyFile(
    join(sourceRoot, "openclaw-plugin", "pnpm-workspace.yaml"),
    join(publication, "pnpm-workspace.yaml"),
  );
  await installDependencies(publication);
  await removeBinDirectories(join(publication, "node_modules"));
  await writeFile(join(publication, "package.json"), finalPluginPackage);
  await writeFile(join(runtime, "package.json"), finalRuntimePackage);
  await rm(join(publication, "pnpm-lock.yaml"));
  await rm(join(publication, "pnpm-workspace.yaml"));
  await rm(join(runtime, "pnpm-lock.yaml"));
}

async function installProductionDependencies(path: string): Promise<void> {
  await execFileAsync(
    "corepack",
    [
      "pnpm",
      "install",
      "--prod",
      "--frozen-lockfile",
      "--config.node-linker=hoisted",
      "--config.auto-install-peers=false",
    ],
    {
      cwd: path,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    },
  );
}

async function disableAutoInstallPeers(path: string): Promise<void> {
  const lockfile = await readFile(path, "utf8");
  const updated = lockfile.replace(
    /^\s*autoInstallPeers:\s*true\s*$/m,
    "  autoInstallPeers: false",
  );
  if (updated === lockfile)
    throw new Error("pnpm lockfile does not declare autoInstallPeers: true");
  await writeFile(path, updated);
}

async function removeBinDirectories(path: string): Promise<void> {
  for (const child of await readdir(path)) {
    const candidate = join(path, child);
    const metadata = await lstat(candidate);
    if (child === ".bin" && metadata.isDirectory()) {
      await rm(candidate, { recursive: true, force: true });
      continue;
    }
    if (metadata.isDirectory() && !metadata.isSymbolicLink())
      await removeBinDirectories(candidate);
  }
}

async function normalizeTree(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`native OpenClaw plugin cannot contain symlinks: ${path}`);
  }
  if (metadata.isDirectory()) {
    await chmod(path, 0o755);
    for (const child of (await readdir(path)).sort())
      await normalizeTree(join(path, child));
    return;
  }
  if (!metadata.isFile())
    throw new Error(`native plugin contains unsupported entry: ${path}`);
  await chmod(path, metadata.mode & 0o111 ? 0o755 : 0o644);
}

async function collectChildren(
  root: string,
  path: string,
): Promise<PackageEntry[]> {
  const entries: PackageEntry[] = [];
  for (const child of (await readdir(path)).sort()) {
    if (path === root && child === MANIFEST_NAME) continue;
    entries.push(...(await collectEntry(root, join(path, child))));
  }
  return entries;
}

async function collectEntry(
  root: string,
  path: string,
): Promise<PackageEntry[]> {
  const logicalPath = relative(root, path).split(sep).join("/");
  assertPackagePath(logicalPath);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(
      `native OpenClaw plugin cannot contain symlinks: ${logicalPath}`,
    );
  }
  if (metadata.isDirectory()) {
    return [
      { path: logicalPath, type: "directory", mode: 0o755, size: 0 },
      ...(await collectChildren(root, path)),
    ];
  }
  if (!metadata.isFile())
    throw new Error(`native plugin contains unsupported entry: ${logicalPath}`);
  if (metadata.size > MAX_ENTRY_BYTES)
    throw new Error(`native plugin entry is too large: ${logicalPath}`);
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
    throw new Error(`unsafe native plugin path: ${JSON.stringify(path)}`);
}

function compareEntries(left: PackageEntry, right: PackageEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function canonicalManifest(manifest: NativeOpenClawPackageManifest): string {
  const value = canonicalize(manifest);
  if (!value)
    throw new Error("native plugin manifest could not be canonicalized");
  return `${value}\n`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
