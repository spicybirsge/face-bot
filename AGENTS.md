# Repository instructions

## Project

- This repository is for a discord.js bot and a read-only Express API that publish news from one configured Discord Channel Following destination. Write the service and its tests in TypeScript. See [plan.md](plan.md) for the implementation order and acceptance checks.
- Restrict ingestion to the configured destination channel and followed source. Use one normalization path for historical and live messages. Keep unverified categories unset.
- Keep Discord requests in the ingestion and sync paths. Serve JSON and RSS from the same persisted archive. Preserve stable article identifiers across retries and edits, and propagate source deletions to both outputs.
- Keep bot tokens and local database files out of version control. Document required permissions, configuration, and verification commands as the implementation adds them.

## Model and delegation preferences

- The user has no paid OpenCode subscription or credits. When using OpenCode, select only models explicitly labeled Free in the current model catalog. Never fall back to a paid OpenCode model unless the user explicitly authorizes it.
- For OpenCode, prefer DeepSeek V4.1 Flash explicitly labeled Free in the current catalog, with high reasoning. Verify the exact model ID and supported reasoning option before use. An unlabeled DeepSeek model is not authorized. If the Free variant is unavailable, report it without substituting another model.
- Council uses these three members, overriding the council skill's default flagship selection.
  - GPT 6.1 Sol through Codex, with extra-high reasoning (`xhigh`).
  - Gemini 3.8 Flash through Antigravity.
  - DeepSeek V4.1 Flash through OpenCode, explicitly labeled Free in the current catalog, with high reasoning when supported.
- If one or more primary council members are unavailable, GitHub Copilot is the first fallback member. If two or more primary members are unavailable, Command Code is the second fallback member. Use each fallback at most once, retaining available primary members and aiming for three distinct providers.
- Before starting council, verify each member's exact model ID, provider availability, and supported reasoning options against the current catalog. For GitHub Copilot and Command Code fallbacks, resolve an available strong model from that provider's current catalog, with high reasoning when supported. Report unavailable primary members and any fallback selections. If the authorized fallbacks cannot fill the council, report the remaining unavailable seats. Do not make other substitutions or enable paid on-demand usage. An unlabeled OpenCode model is not authorized.
- Command Code remains allowed for other delegation when available.
