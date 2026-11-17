# dsh-provider-guard

A DSH bundle plugin that keeps every model call on the provider currently
selected in the UI.

- Selected opencode -> model calls go to opencode.
- Selected DeepSeek -> model calls go to DeepSeek.
- A main-loop request that tries a different provider, including an automatic
  fallback after a failure, is stopped with `PROVIDER_AUTO_SWITCH_BLOCKED` and
  reported in chat.
- Cross-provider auxiliary calls (title, compaction, memory, ...) are blocked
  by default; `onForeignProvider: reroute` is opt-in.
- Other providers' endpoints (DeepSeek `/models`, `/v1/tools/search`, etc.) are
  blocked; ordinary traffic (npm, WeChat, remote control, web fetch) is not.
- Failures retry the same provider only; the final error tells the user to
  change provider manually.

## Install

```sh
# npm (after publishing)
dsh plugin --profile desktop add dsh-provider-guard
dsh plugin --profile web add dsh-provider-guard

# GitHub source
dsh plugin --profile desktop add github:tanqvv/dsh-provider-guard#v0.2.3
dsh plugin --profile web add github:tanqvv/dsh-provider-guard#v0.2.3

# local tarball
dsh plugin --profile desktop add /path/to/dsh-provider-guard-0.2.3.tgz
dsh plugin --profile web add /path/to/dsh-provider-guard-0.2.3.tgz
```

Optional per-profile override:

```sh
node /path/to/dsh-provider-guard/scripts/install.mjs --apply --bundle
```

## Verify

Ask the agent to call `provider_guard_status`, then:

```sh
tail -f ~/.dsh/provider-guard/audit-desktop.jsonl
```

A DeepSeek web search under opencode should fail with
`PROVIDER_HOST_BLOCKED`; a normal `web_fetch https://example.com` should work.

## Limits

- One active provider at a time; sessions using another provider stop and ask
  for a manual switch.
- Subprocesses, the Electron main process, and DNS are outside the plugin.
- Custom gateways need `providerHosts` entries.
- Same-provider retries follow DSH's `retryPolicy` (default 5); set
  `maxRetries: 0` to stop on the first failure.

Chinese documentation: [README.md](README.md).
