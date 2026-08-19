declare module "@openclaw/discord/dist/runtime-api.send.js" {
  import type {
    DiscordComponentMessageSpec,
    DiscordComponentSendOpts,
    DiscordComponentSendResult,
  } from "openclaw/plugin-sdk/discord";

  export function editDiscordComponentMessage(
    to: string,
    messageId: string,
    spec: DiscordComponentMessageSpec,
    opts: DiscordComponentSendOpts,
  ): Promise<DiscordComponentSendResult>;
}
