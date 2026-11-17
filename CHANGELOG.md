# Changelog

## 0.2.3

- Published as a standard DSH bundle package (npm / GitHub Release).
- Model calls follow the provider selected in the UI.
- No automatic provider switching or fallback: a mismatched main-loop provider
  is stopped with `PROVIDER_AUTO_SWITCH_BLOCKED`; terminal failures carry a
  "change provider manually" note in chat.
- Cross-provider auxiliary calls are blocked by default; `reroute` remains
  opt-in.
- Other providers' endpoints (including `/models` discovery and DeepSeek web
  search) are blocked; ordinary traffic is untouched.
- `provider_guard_status` / `egress_guard_status` status tools.
- 18 unit tests plus a real-`LlmRuntime` smoke script.

## 0.2.2

- Bundle packaging, profile override installer, web/VS Code validation.

## 0.2.0

- Initial provider-affinity implementation.
