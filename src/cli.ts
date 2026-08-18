#!/usr/bin/env node
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { PrimeDispatcher } from "./dispatcher.js";
import { PrimeStartInputSchema } from "./schemas.js";
import { loadHostConfig, resolveHostRepositoryPolicy } from "./host-config.js";

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

withStateRoot(
  program
    .command("start")
    .description("preview and launch a confirmed Prime job")
    .requiredOption("--task <text>")
    .requiredOption("--repo <path>")
    .option("--repo-root <path>", "allowed repository root", collect, [])
    .requiredOption("--channel <id>")
    .requiredOption("--sender <id>")
    .option("--base <ref>")
    .option("--fixture")
    .option("--unsafe-allow-live-repo")
    .option("--gate <json>", "verification gate JSON", collect, [])
    .option("--wall-clock-ms <milliseconds>")
    .option("--host-config <path>")
    .addOption(new Option("--agent <kind>").choices(["fake", "prime"]))
    .option("--confirm-hash <sha256>")
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
          ...(options.wallClockMs
            ? { wallClockMs: Number(options.wallClockMs) }
            : {}),
        },
        authorization: {
          channelId: options.channel,
          senderId: options.sender,
        },
        agent: hostPolicy?.agent ?? { kind: "fake" },
      });
      const preview = await dispatcher.preview(input);
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

for (const [name, description, action] of [
  ["status", "show current job state", "status"],
  ["cancel", "cancel a nonterminal job", "cancel"],
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
    .command("steer")
    .description("send guidance during an active Prime turn")
    .requiredOption("--job-id <id>")
    .requiredOption("--message <text>")
    .action(async (options) => {
      const dispatcher = await createDispatcher(options);
      print(await dispatcher.steer(options.jobId, options.message));
    }),
);

void program.parseAsync().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
