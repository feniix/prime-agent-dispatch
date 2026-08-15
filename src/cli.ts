#!/usr/bin/env node
import { resolve } from "node:path";
import { PrimeDispatcher } from "./dispatcher.js";
import { PrimeStartInputSchema } from "./schemas.js";
import { loadHostConfig, resolveHostRepositoryPolicy } from "./host-config.js";

type ParsedArgs = { command: string | undefined; flags: Map<string, string[]> };

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const next = rest[index + 1];
    const value =
      next && !next.startsWith("--") ? ((index += 1), next) : "true";
    const existing = flags.get(key) ?? [];
    existing.push(value);
    flags.set(key, existing);
  }
  return { command, flags };
}

function one(
  flags: Map<string, string[]>,
  name: string,
  required = false,
): string | undefined {
  const value = flags.get(name)?.at(-1);
  if (required && !value) throw new Error(`missing ${name}`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): never {
  throw new Error(
    [
      "usage:",
      "  prime-dispatch start --task TEXT --repo PATH --repo-root PATH --channel ID --sender ID --fixture",
      "  prime-dispatch status --job-id ID",
      "  prime-dispatch steer --job-id ID --message TEXT",
      "  prime-dispatch cancel --job-id ID",
      "  prime-dispatch result --job-id ID",
      "common: --state-root PATH (default .prime-dispatch or PRIME_DISPATCH_STATE_ROOT)",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const stateRoot = resolve(
    one(parsed.flags, "--state-root") ??
      process.env.PRIME_DISPATCH_STATE_ROOT ??
      ".prime-dispatch",
  );
  const dispatcher = new PrimeDispatcher(stateRoot);
  if (parsed.command === "start") {
    const callerGates = (parsed.flags.get("--gate") ?? []).map(
      (gate) => JSON.parse(gate) as unknown,
    );
    const hostConfigPath = one(parsed.flags, "--host-config");
    const repoPath = one(parsed.flags, "--repo", true)!;
    const hostPolicy = hostConfigPath
      ? await resolveHostRepositoryPolicy(
          await loadHostConfig(hostConfigPath),
          repoPath,
        )
      : undefined;
    if (one(parsed.flags, "--agent") === "prime" && !hostPolicy)
      throw new Error(
        "real Prime jobs require --host-config; caller-supplied Prime paths are rejected",
      );
    const input = PrimeStartInputSchema.parse({
      task: one(parsed.flags, "--task", true),
      repoPath,
      repoRoots: hostPolicy?.repoRoots ?? parsed.flags.get("--repo-root") ?? [],
      ...(one(parsed.flags, "--base")
        ? { baseRef: one(parsed.flags, "--base") }
        : {}),
      fixture: one(parsed.flags, "--fixture") === "true",
      unsafeAllowLiveRepo:
        one(parsed.flags, "--unsafe-allow-live-repo") === "true",
      gates: hostPolicy?.gates ?? callerGates,
      budget: {
        ...(one(parsed.flags, "--wall-clock-ms")
          ? { wallClockMs: Number(one(parsed.flags, "--wall-clock-ms")) }
          : {}),
      },
      authorization: {
        channelId: one(parsed.flags, "--channel", true),
        senderId: one(parsed.flags, "--sender", true),
      },
      agent: hostPolicy?.agent ?? { kind: "fake" },
    });
    const preview = await dispatcher.preview(input);
    const suppliedHash = one(parsed.flags, "--confirm-hash");
    const explicitYes = one(parsed.flags, "--yes") === "true";
    if (!explicitYes && !suppliedHash) {
      throw new Error(
        `confirmation required; review this immutable resolved request and rerun with --confirm-hash ${preview.summary.requestHash}:\n${JSON.stringify(preview.summary, null, 2)}`,
      );
    }
    print(
      await dispatcher.startConfirmed(
        preview,
        explicitYes ? preview.summary.requestHash : suppliedHash!,
      ),
    );
    return;
  }
  const jobId = one(parsed.flags, "--job-id", true)!;
  if (parsed.command === "status") print(await dispatcher.status(jobId));
  else if (parsed.command === "steer")
    print(await dispatcher.steer(jobId, one(parsed.flags, "--message", true)!));
  else if (parsed.command === "cancel") print(await dispatcher.cancel(jobId));
  else if (parsed.command === "result") print(await dispatcher.result(jobId));
  else usage();
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
