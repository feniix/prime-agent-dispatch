#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Command } from "commander";
import {
  auditOpenClawInstall,
  installOpenClaw,
  openClawLayout,
  planOpenClawInstall,
  rollbackOpenClaw,
  uninstallOpenClaw,
  type OpenClawLifecycleDependencies,
  type OpenClawPluginConfig,
} from "./openclaw-install.js";
import { buildNativeOpenClawPluginPackage } from "./openclaw-native-package.js";

const execFileAsync = promisify(execFile);
const defaultSourceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

type CommonOptions = OpenClawPluginConfig & {
  openclawStateDir: string;
  openclawBin: string;
  restartGateway?: boolean;
};

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function withCommonOptions(command: Command): Command {
  return command
    .option(
      "--openclaw-state-dir <path>",
      "OpenClaw state directory",
      join(homedir(), ".openclaw"),
    )
    .option("--openclaw-bin <path>", "OpenClaw CLI executable", "openclaw")
    .option(
      "--confirmation-ttl-ms <milliseconds>",
      "confirmation lifetime in milliseconds",
      Number,
    )
    .option(
      "--max-rendered-chars <characters>",
      "maximum rendered preview characters",
      Number,
    )
    .option(
      "--notification-poll-ms <milliseconds>",
      "notification poll interval in milliseconds",
      Number,
    )
    .option(
      "--restart-gateway",
      "restart the Gateway after activation or registry repair",
    );
}

function pluginConfig(options: CommonOptions): OpenClawPluginConfig {
  return {
    ...(options.confirmationTtlMs === undefined
      ? {}
      : { confirmationTtlMs: options.confirmationTtlMs }),
    ...(options.maxRenderedChars === undefined
      ? {}
      : { maxRenderedChars: options.maxRenderedChars }),
    ...(options.notificationPollMs === undefined
      ? {}
      : { notificationPollMs: options.notificationPollMs }),
  };
}

function dependencies(options: CommonOptions): OpenClawLifecycleDependencies {
  const layout = openClawLayout(options.openclawStateDir);
  const openclawEnvironment = {
    ...process.env,
    OPENCLAW_STATE_DIR: layout.openclawStateDir,
    OPENCLAW_CONFIG_PATH: layout.openclawConfigPath,
  };
  const runOpenClaw = async (args: string[]) =>
    await execFileAsync(options.openclawBin, args, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: openclawEnvironment,
    });
  return {
    async installProductionDependencies(path) {
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
    },
    async readOpenClawVersion() {
      const { stdout, stderr } = await runOpenClaw(["--version"]);
      const match = `${stdout}\n${stderr}`.match(/\b(\d{4}\.\d+\.\d+)\b/);
      if (!match) throw new Error("could not determine OpenClaw version");
      return match[1]!;
    },
    async readConfigValue(path) {
      try {
        const { stdout } = await runOpenClaw(["config", "get", path, "--json"]);
        return JSON.parse(stdout) as unknown;
      } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        if (
          typeof stderr === "string" &&
          stderr.includes("Config path not found:")
        )
          return undefined;
        throw error;
      }
    },
    async applyConfigPatch(patch, replacePaths = []) {
      const scratch = await mkdtemp(join(tmpdir(), "prime-dispatch-config-"));
      const patchPath = join(scratch, "patch.json");
      try {
        await writeFile(patchPath, `${JSON.stringify(patch, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        const replaceArgs = replacePaths.flatMap((path) => [
          "--replace-path",
          path,
        ]);
        await runOpenClaw([
          "config",
          "patch",
          "--file",
          patchPath,
          "--dry-run",
          "--json",
          ...replaceArgs,
        ]);
        await runOpenClaw([
          "config",
          "patch",
          "--file",
          patchPath,
          ...replaceArgs,
        ]);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    async validateConfig() {
      await runOpenClaw(["config", "validate", "--json"]);
    },
    async refreshPluginRegistry() {
      await runOpenClaw(["plugins", "registry", "--refresh", "--json"]);
    },
    async readPluginSource() {
      const { stdout } = await runOpenClaw([
        "plugins",
        "info",
        "prime-dispatch",
        "--json",
      ]);
      const result = JSON.parse(stdout) as {
        plugin?: { source?: unknown };
      };
      return typeof result.plugin?.source === "string"
        ? result.plugin.source
        : undefined;
    },
    async restartGateway() {
      await runOpenClaw(["gateway", "restart"]);
    },
    now: () => new Date(),
  };
}

const program = new Command()
  .name("prime-dispatch-openclaw")
  .description("Durable Prime Dispatch lifecycle for one OpenClaw host")
  .showHelpAfterError()
  .showSuggestionAfterError();

withCommonOptions(
  program
    .command("plan")
    .description("print the exact paths and OpenClaw config delta")
    .option("--release-id <id>"),
).action(async (options: CommonOptions & { releaseId?: string }) => {
  print(
    await planOpenClawInstall(
      {
        openclawStateDir: options.openclawStateDir,
        ...(options.releaseId ? { releaseId: options.releaseId } : {}),
        ...pluginConfig(options),
      },
      dependencies(options),
    ),
  );
});

withCommonOptions(
  program
    .command("install")
    .description("install or upgrade one durable release")
    .requiredOption("--host-config-source <path>")
    .option("--state-source <path>", "one-time state migration source")
    .option("--source-root <path>", "built repository root", defaultSourceRoot)
    .option("--release-id <id>"),
).action(
  async (
    options: CommonOptions & {
      sourceRoot: string;
      hostConfigSource: string;
      stateSource?: string;
      releaseId?: string;
    },
  ) => {
    print(
      await installOpenClaw(
        {
          openclawStateDir: options.openclawStateDir,
          sourceRoot: options.sourceRoot,
          hostConfigSource: options.hostConfigSource,
          ...(options.stateSource ? { stateSource: options.stateSource } : {}),
          ...(options.releaseId ? { releaseId: options.releaseId } : {}),
          restartGateway: Boolean(options.restartGateway),
          ...pluginConfig(options),
        },
        dependencies(options),
      ),
    );
  },
);

program
  .command("package-build")
  .description("build a native online or offline OpenClaw plugin package")
  .requiredOption("--variant <variant>", "online or offline", (value) => {
    if (value !== "online" && value !== "offline")
      throw new Error("package variant must be online or offline");
    return value;
  })
  .requiredOption("--source-commit <sha>", "full source Git commit SHA")
  .requiredOption("--openclaw-version <version>")
  .requiredOption("--release-id <id>")
  .requiredOption(
    "--prime-runtime <path>",
    "verified target-native Prime runtime",
  )
  .requiredOption("--prime-runtime-sha256 <digest>")
  .option("--prime-runtime-url <url>", "HTTPS runtime URL for online packages")
  .option("--source-root <path>", "built repository root", defaultSourceRoot)
  .requiredOption("--output <path>")
  .action(
    async (options: {
      variant: "online" | "offline";
      sourceCommit: string;
      openclawVersion: string;
      releaseId: string;
      primeRuntime: string;
      primeRuntimeSha256: string;
      primeRuntimeUrl?: string;
      sourceRoot: string;
      output: string;
    }) => {
      const { stdout: sourceHead } = await execFileAsync(
        "git",
        ["-C", options.sourceRoot, "rev-parse", "HEAD"],
        {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 64 * 1024,
        },
      );
      if (sourceHead.trim() !== options.sourceCommit)
        throw new Error(
          `source commit mismatch: expected ${options.sourceCommit}, got ${sourceHead.trim()}`,
        );
      const built = await buildNativeOpenClawPluginPackage({
        variant: options.variant,
        sourceRoot: options.sourceRoot,
        sourceCommit: options.sourceCommit,
        openclawVersion: options.openclawVersion,
        releaseId: options.releaseId,
        primeRuntimeArtifact: options.primeRuntime,
        primeRuntimeSha256: options.primeRuntimeSha256,
        ...(options.primeRuntimeUrl
          ? { primeRuntimeUrl: options.primeRuntimeUrl }
          : {}),
        output: options.output,
      });
      print({
        artifactPath: built.artifactPath,
        artifactSha256: built.artifactSha256,
        manifestSha256: built.manifestSha256,
        variant: built.manifest.variant,
        releaseId: built.manifest.releaseId,
        target: built.manifest.target,
        prime: built.manifest.prime,
        entryCount: built.manifest.entries.length,
      });
    },
  );

withCommonOptions(
  program.command("rollback").description("activate the previous release"),
).action(async (options: CommonOptions) => {
  print(
    await rollbackOpenClaw(
      {
        openclawStateDir: options.openclawStateDir,
        restartGateway: Boolean(options.restartGateway),
        ...pluginConfig(options),
      },
      dependencies(options),
    ),
  );
});

withCommonOptions(
  program
    .command("uninstall")
    .description("disable the integration while preserving state and releases"),
).action(async (options: CommonOptions) => {
  print(
    await uninstallOpenClaw(
      {
        openclawStateDir: options.openclawStateDir,
        restartGateway: Boolean(options.restartGateway),
        ...pluginConfig(options),
      },
      dependencies(options),
    ),
  );
});

program
  .command("audit")
  .description("validate ownership, permissions, active links, and releases")
  .option(
    "--openclaw-state-dir <path>",
    "OpenClaw state directory",
    join(homedir(), ".openclaw"),
  )
  .option("--openclaw-bin <path>", "OpenClaw CLI executable", "openclaw")
  .action(async (options: CommonOptions) => {
    const violations = await auditOpenClawInstall(
      options.openclawStateDir,
      dependencies(options),
    );
    print({ ok: violations.length === 0, violations });
    if (violations.length > 0) process.exitCode = 1;
  });

void program.parseAsync().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
  const details = [stdout, stderr]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  process.stderr.write(
    `${message}${details.length > 0 ? `\n${details.join("\n")}` : ""}\n`,
  );
  process.exitCode = 1;
});
