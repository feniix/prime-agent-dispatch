#!/usr/bin/env node
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command, Option } from "commander";
import { PrimeDispatcher } from "./dispatcher.js";
import { AuthorizationSchema, PrimeStartInputSchema } from "./schemas.js";
import { loadHostConfig, resolveHostRepositoryPolicy } from "./host-config.js";
import { CleanupManager } from "./cleanup.js";
import {
  CONTROL_DATABASE_NAME,
  inspectControlMigrations,
  openControlDatabase,
} from "./sqlite.js";
import { buildPrimeRuntimeArtifact } from "./prime-runtime-artifact.js";
import { PRIME_AGENT_COMMIT, PRIME_AGENT_VERSION } from "./release.js";

type CommonOptions = { stateRoot?: string };

function stateRoot(options: CommonOptions): string {
  return resolve(
    options.stateRoot ??
      process.env.PRIME_DISPATCH_STATE_ROOT ??
      ".prime-dispatch",
  );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function withStateRoot(command: Command): Command {
  return command.option(
    "--state-root <path>",
    "durable state root (defaults to PRIME_DISPATCH_STATE_ROOT or .prime-dispatch)",
  );
}

function withResumeAuthorization(command: Command): Command {
  return command
    .requiredOption("--channel <id>")
    .requiredOption("--sender <id>")
    .requiredOption("--owner")
    .option("--provider <id>")
    .option("--account <id>")
    .option("--thread <id>")
    .option("--delivery <id>");
}

function resumeAuthorization(options: Record<string, unknown>) {
  return AuthorizationSchema.parse({
    ...(typeof options.provider === "string"
      ? { provider: options.provider }
      : {}),
    channelId: options.channel,
    senderId: options.sender,
    senderIsOwner: options.owner === true,
    ...(typeof options.account === "string"
      ? { accountId: options.account }
      : {}),
    ...(typeof options.thread === "string" ? { threadId: options.thread } : {}),
    ...(typeof options.delivery === "string"
      ? { deliveryId: options.delivery }
      : {}),
  });
}

async function createDispatcher(
  options: CommonOptions,
): Promise<PrimeDispatcher> {
  const dispatcher = new PrimeDispatcher(stateRoot(options));
  await dispatcher.reconcileNonterminalJobs();
  return dispatcher;
}

const program = new Command()
  .name("prime-dispatch")
  .description("Detached single-root Prime job control")
  .showHelpAfterError()
  .showSuggestionAfterError();

program
  .command("runtime-build")
  .description("build one reproducible self-contained Prime runtime artifact")
  .requiredOption("--source <path>", "complete Prime package directory")
  .requiredOption("--release-artifact <path>", "official pinned Prime release")
  .requiredOption("--lockfile <path>", "pnpm lockfile used for dependencies")
  .requiredOption("--output <path>", "new .tgz artifact path")
  .option(
    "--entrypoint <path>",
    "entrypoint relative to source",
    "dist/bundle/cli.js",
  )
  .action(async (options) => {
    const built = await buildPrimeRuntimeArtifact({
      sourceDir: resolve(options.source),
      releaseArtifact: resolve(options.releaseArtifact),
      lockfile: resolve(options.lockfile),
      output: resolve(options.output),
      entrypoint: options.entrypoint,
      primeVersion: PRIME_AGENT_VERSION,
      primeCommit: PRIME_AGENT_COMMIT,
    });
    print({
      artifactPath: built.artifactPath,
      artifactSha256: built.artifactSha256,
      manifestSha256: built.manifestSha256,
      primeVersion: built.manifest.primeVersion,
      primeCommit: built.manifest.primeCommit,
      platform: built.manifest.platform,
      architecture: built.manifest.architecture,
      nodeVersion: built.manifest.nodeVersion,
      entries: built.manifest.entries.length,
    });
  });

withStateRoot(
  program
    .command("migration-apply")
    .description("apply pending control-database migrations")
    .action((options) => {
      const database = openControlDatabase(stateRoot(options));
      try {
        print(inspectControlMigrations(database));
      } finally {
        database.close();
      }
    }),
);

withStateRoot(
  program
    .command("migration-status")
    .description(
      "verify control-database migration history without changing it",
    )
    .action((options) => {
      const database = new DatabaseSync(
        join(stateRoot(options), CONTROL_DATABASE_NAME),
        { readOnly: true },
      );
      try {
        print(inspectControlMigrations(database));
      } finally {
        database.close();
      }
    }),
);

withStateRoot(
  program
    .command("start")
    .description("preview and launch a confirmed Prime job")
    .requiredOption("--task <text>")
    .requiredOption("--repo <path>")
    .option("--repo-root <path>", "allowed repository root", collect, [])
    .requiredOption("--channel <id>")
    .requiredOption("--sender <id>")
    .option("--provider <id>", "trusted delivery provider identity")
    .option("--owner", "record trusted OpenClaw owner authorization")
    .option("--account <id>", "trusted delivery account identity")
    .option("--thread <id>", "trusted delivery thread identity")
    .option("--delivery <id>", "trusted inbound delivery identity")
    .option("--base <ref>")
    .option("--fixture")
    .option("--unsafe-allow-live-repo")
    .option("--gate <json>", "verification gate JSON", collect, [])
    .option("--wall-clock-ms <milliseconds>")
    .option("--host-config <path>")
    .addOption(new Option("--agent <kind>").choices(["fake", "prime"]))
    .option("--confirm-hash <sha256>")
    .option("--preview", "return the resolved request without launching")
    .option(
      "--yes",
      "accept a fake fixture preview without a second invocation",
    )
    .action(async (options) => {
      const dispatcher = await createDispatcher(options);
      const callerGates = options.gate.map(
        (gate: string) => JSON.parse(gate) as unknown,
      );
      const hostPolicy = options.hostConfig
        ? await resolveHostRepositoryPolicy(
            await loadHostConfig(options.hostConfig),
            options.repo,
          )
        : undefined;
      if (options.agent === "prime" && !hostPolicy)
        throw new Error(
          "real Prime jobs require --host-config; caller-supplied Prime paths are rejected",
        );
      const input = PrimeStartInputSchema.parse({
        task: options.task,
        repoPath: options.repo,
        repoRoots: hostPolicy?.repoRoots ?? options.repoRoot,
        ...(options.base ? { baseRef: options.base } : {}),
        fixture: hostPolicy?.fixture ?? Boolean(options.fixture),
        unsafeAllowLiveRepo: Boolean(options.unsafeAllowLiveRepo),
        gates: hostPolicy?.gates ?? callerGates,
        budget: {
          ...(hostPolicy?.multiChild
            ? { maxTokens: hostPolicy.multiChild.aggregateMaxTokens }
            : {}),
          ...(options.wallClockMs
            ? { wallClockMs: Number(options.wallClockMs) }
            : {}),
        },
        authorization: {
          ...(options.provider ? { provider: options.provider } : {}),
          channelId: options.channel,
          senderId: options.sender,
          ...(options.owner ? { senderIsOwner: true } : {}),
          ...(options.account ? { accountId: options.account } : {}),
          ...(options.thread ? { threadId: options.thread } : {}),
          ...(options.delivery ? { deliveryId: options.delivery } : {}),
        },
        agent: hostPolicy?.agent ?? { kind: "fake" },
      });
      const preview = await dispatcher.preview(input, hostPolicy?.multiChild);
      if (options.preview) {
        print({ resolvedRequest: preview.summary, input: preview.input });
        return;
      }
      process.stderr.write(
        `${JSON.stringify({ resolvedRequest: preview.summary }, null, 2)}\n`,
      );
      if (options.yes && input.agent.kind !== "fake")
        throw new Error(
          "--yes is limited to fake fixture jobs; real Prime requires a reviewed --confirm-hash",
        );
      if (!options.yes && !options.confirmHash) {
        throw new Error(
          `confirmation required; review this immutable resolved request and rerun with --confirm-hash ${preview.summary.requestHash}:\n${JSON.stringify(preview.summary, null, 2)}`,
        );
      }
      print(
        await dispatcher.startConfirmed(
          preview,
          options.yes ? preview.summary.requestHash : options.confirmHash,
        ),
      );
    }),
);

withStateRoot(
  program
    .command("cleanup-plan")
    .description(
      "create one immutable dry-run cleanup plan from trusted host policy",
    )
    .requiredOption("--host-config <path>")
    .action(async (options) => {
      const manager = new CleanupManager(stateRoot(options));
      try {
        const config = await loadHostConfig(options.hostConfig);
        print(await manager.plan(config.retention));
      } finally {
        manager.close();
      }
    }),
);

withStateRoot(
  program
    .command("cleanup-apply")
    .description("apply or resume one exact durable cleanup plan")
    .requiredOption("--run-id <uuid>")
    .action(async (options) => {
      const manager = new CleanupManager(stateRoot(options));
      try {
        print(await manager.apply(options.runId));
      } finally {
        manager.close();
      }
    }),
);

withStateRoot(
  withResumeAuthorization(
    program
      .command("resume-preview")
      .description("preview a mechanically safe resume for an interrupted job")
      .requiredOption("--job-id <id>"),
  ).action(async (options) => {
    const dispatcher = await createDispatcher(options);
    print(
      await dispatcher.previewResume(
        options.jobId,
        resumeAuthorization(options),
      ),
    );
  }),
);

withStateRoot(
  withResumeAuthorization(
    program
      .command("resume-confirm")
      .description("launch one previously previewed safe resume")
      .requiredOption("--job-id <id>")
      .requiredOption("--confirmation-token <uuid>"),
  ).action(async (options) => {
    const dispatcher = await createDispatcher(options);
    print(
      await dispatcher.resumeConfirmed(
        options.jobId,
        options.confirmationToken,
        resumeAuthorization(options),
      ),
    );
  }),
);

for (const [name, description, action] of [
  ["status", "show current job state", "status"],
  ["result", "read a terminal job result", "result"],
] as const) {
  withStateRoot(
    program
      .command(name)
      .description(description)
      .requiredOption("--job-id <id>")
      .action(async (options) => {
        const dispatcher = await createDispatcher(options);
        print(await dispatcher[action](options.jobId));
      }),
  );
}

withStateRoot(
  program
    .command("tree-status")
    .description("show current job state and bounded child tree")
    .requiredOption("--job-id <id>")
    .action(async (options) => {
      const dispatcher = await createDispatcher(options);
      print(await dispatcher.treeStatus(options.jobId));
    }),
);

withStateRoot(
  program
    .command("cancel")
    .description(
      "cancel a root job or route one child cancellation to its root",
    )
    .requiredOption("--job-id <id>")
    .option("--child-id <uuid>")
    .action(async (options) => {
      const dispatcher = await createDispatcher(options);
      print(await dispatcher.cancel(options.jobId, options.childId));
    }),
);

withStateRoot(
  program
    .command("steer")
    .description("send guidance during an active Prime turn")
    .requiredOption("--job-id <id>")
    .requiredOption("--message <text>")
    .option(
      "--child-id <uuid>",
      "route guidance through the root for one child",
    )
    .action(async (options) => {
      const dispatcher = await createDispatcher(options);
      print(
        await dispatcher.steer(options.jobId, options.message, options.childId),
      );
    }),
);

withStateRoot(
  program
    .command("jobs")
    .description("list durable Prime Dispatch job identities")
    .action(async (options) => {
      const dispatcher = await createDispatcher(options);
      print({ jobIds: await dispatcher.store.listJobIds() });
    }),
);

withStateRoot(
  program
    .command("notifications")
    .description(
      "read pending lifecycle notifications for one durable consumer",
    )
    .requiredOption("--job-id <id>")
    .requiredOption("--consumer-id <id>")
    .action(async (options) => {
      const dispatcher = await createDispatcher(options);
      print({
        request: await dispatcher.store.readRequest(options.jobId),
        state: await dispatcher.store.readState(options.jobId),
        childTree: await dispatcher.store.readChildTree(options.jobId),
        notifications: await dispatcher.store.pendingLifecycleNotifications(
          options.jobId,
          options.consumerId,
        ),
      });
    }),
);

withStateRoot(
  program
    .command("notification-ack")
    .description("advance one durable lifecycle notification cursor")
    .requiredOption("--job-id <id>")
    .requiredOption("--consumer-id <id>")
    .requiredOption("--through-sequence <sequence>")
    .action(async (options) => {
      const dispatcher = await createDispatcher(options);
      await dispatcher.store.acknowledgeLifecycleNotification(
        options.jobId,
        options.consumerId,
        Number(options.throughSequence),
      );
      print({
        acknowledged: true,
        throughSequence: Number(options.throughSequence),
      });
    }),
);

void program.parseAsync().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
