import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("Prime Dispatch OpenClaw plugin", () => {
  it("registers five optional typed tools and Discord confirmation commands", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const api = {
      pluginConfig: {
        cliPath: "/trusted/cli.js",
        stateRoot: "/trusted/state",
        hostConfigPath: "/trusted/host.json",
      },
      registerTool: vi.fn((_factory, options) => tools.push(...options.names)),
      registerCommand: vi.fn((command) => commands.push(command.name)),
      registerService: vi.fn(),
      runtime: { gateway: { request: vi.fn() } },
      logger: { warn: vi.fn() },
    };
    plugin.register(api as any);
    expect(tools).toEqual([
      "prime_start",
      "prime_status",
      "prime_steer",
      "prime_cancel",
      "prime_result",
    ]);
    expect(commands).toEqual(["prime-confirm", "prime-status"]);
  });
});
