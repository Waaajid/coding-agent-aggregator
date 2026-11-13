# Contributing

Thanks for helping. This is a small, local-first project; keep changes focused.

## Setup

```bash
corepack pnpm install
corepack pnpm -r typecheck
corepack pnpm -r test
npm run demo        # mock agents, throwaway repo, no API usage
```

Requires Node.js 22+ and git. Tests use real git and mock agent CLIs, so no API keys are needed.

## Pull requests

- Open an issue first for anything larger than a bug fix.
- Add or update tests for behaviour changes; `typecheck` and `test` must pass (CI runs both).
- Security-relevant changes (auth, approvals, the hook, host/origin checks) need a test that shows the failure case.
- By contributing you agree your work is licensed under the [MIT License](LICENSE).

## Adding an agent

Adapters live in `packages/daemon/src/adapters`. Most CLIs only need an entry in `agents.json` (see `docs/02_AGENT_ADAPTERS_AND_GIT_ENGINE.md`); write a code adapter only if you need native resume or output parsing.
