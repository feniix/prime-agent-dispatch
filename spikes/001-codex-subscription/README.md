# Spike 001: Codex subscription brokerage

## Question

Can one root-only Prime Agent process use `gpt-5.6-sol` with `high` reasoning through an OpenClaw-held Codex subscription broker while Prime receives only a scoped, revocable job token?

The beta is blocked unless this spike returns `VALIDATED`. An API key, a copied OAuth credential, a Codex runner, or a nested OpenClaw/Codex agent turn is not an acceptable fallback.

## Experiment

`run.mjs` performs one self-contained live experiment:

1. Verify the official Prime Agent `v0.7.2` tarball against the release SHA-256.
2. Resolve OpenAI OAuth through OpenClaw's public auth-runtime API inside the trusted broker process.
3. Start a loopback OpenAI Responses proxy with a random job token.
4. Configure Prime with only that loopback URL and scoped token.
5. Start Prime in RPC mode with `RLM_MAX_DEPTH=0`, `gpt-5.6-sol`, `high` reasoning, and only the IPython tool.
6. Make Prime edit a disposable Git fixture and verify the exact file content.
7. Observe a streamed tool-call round trip without recording prompt or response bodies.
8. Abort a second live request, revoke the job token, and prove reuse is rejected before upstream access.
9. Scan Prime's private home, configuration, session data, and fixture for the actual provider access token and account id.

The broker never writes the provider access token, account id, prompt bodies, response bodies, or scoped token to evidence. The scoped token exists once in Prime's private `models.json` for the duration of the experiment; the entire temporary tree is deleted afterward.

## Prerequisites

- OpenClaw with a usable `openai` OAuth profile.
- Node.js 22.8 or newer.
- Prime Agent `v0.7.2` downloaded from its official release.
- The release tarball extracted and its runtime dependencies installed locally.

The recorded run used:

```bash
mkdir -p /var/lib/evie-agent/downloads/prime-agent-0.7.2
tar -xzf /var/lib/evie-agent/downloads/prime-agent-0.7.2.tgz \
  -C /var/lib/evie-agent/downloads/prime-agent-0.7.2
cd /var/lib/evie-agent/downloads/prime-agent-0.7.2/package
corepack pnpm config set --location=project --json allowBuilds \
  '{"@google/genai":true,"koffi":true,"protobufjs":true,"zeromq":true}'
corepack pnpm --config.blockExoticSubdeps=false install --prod
cd /var/lib/evie-agent/src/prime-dispatch-prototype
node spikes/001-codex-subscription/run.mjs
```

The default artifact paths are under `/var/lib/evie-agent/downloads`. Override them with `PRIME_AGENT_TARBALL`, `PRIME_AGENT_EXECUTABLE`, or `OPENCLAW_PACKAGE_JSON` when reproducing elsewhere.

## Verdict

**VALIDATED.** See [`evidence.json`](evidence.json) for the redacted machine-readable record. The verdict is generated from all mandatory checks; any failed check makes it `INVALIDATED`.

The live run proved:

- Prime Agent `0.7.2` used `gpt-5.6-sol` with `high` reasoning through the loopback broker.
- The model received Prime's IPython tool, streamed a function call, and created the exact expected file in a disposable Git repository.
- Prime received only a random scoped token. The OpenAI access token and ChatGPT account id appeared zero times in Prime's environment and temporary files.
- RPC abort cancelled an active upstream request. Revoking the scoped token then rejected a reuse attempt before any upstream request.
- No Git remote operation occurred.

The ChatGPT Codex endpoint rejected the ordinary Responses API fields `max_output_tokens` and `prompt_cache_retention`; the broker must remove them. It also fixes the upstream model and reasoning level server-side rather than trusting Prime's request.

This validates the inference/authentication seam, not the complete beta. The spike broker is a trusted repo-local process using OpenClaw's public auth runtime. Moving the same broker into the thin OpenClaw adapter, adding durable job control, and applying repository policy remain beta implementation work. The provider access token necessarily exists in trusted broker memory while an upstream request is active; the guarantee is that it never enters Prime's process, configuration, logs, artifacts, or evidence.
