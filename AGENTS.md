# AGENTS.md

Working rules for AI coding agents (and people) on this repo. `PLAN.md` is the spec; this file is how we work.

## Working with the user

- The user writes in Chinese. Reply in Chinese. Code, comments, commit messages and identifiers are in English; text the user sees in the app (bot replies, errors, logs) is in Chinese.
- **Plan first.** `PLAN.md` describes every stage and its acceptance criteria. When a design changes, update `PLAN.md` before writing the code, and confirm design choices that are the user's to make. Details the plan leaves open: pick the simplest testable option and note it in README's 设计说明.
- Work one stage at a time; a stage is done when its acceptance criteria pass.
- **Commit only when asked.** No `Co-Authored-By:` trailers or other attribution lines in commit messages. Never commit `.vscode/` or anything in `data/`.
- Report honestly what was and was not verified (unit tests vs. a live run vs. tested by the user in Discord).
- Do not pull Ollama models, or do anything else large or hard to undo, without asking.
- Never print or ask the user to paste tokens, chat ids or calendar links. The user fills secrets into `config.toml` themselves.

## Checks

Run all of these before calling a change done:

```sh
pnpm test        # vitest twice: TZ=UTC and TZ=Pacific/Auckland
pnpm lint        # eslint (including module boundaries) + prettier --check
pnpm typecheck
```

After changing dependencies, `Dockerfile` or `compose.yaml`, also run `docker compose build` and check the container starts (`docker compose up -d`, `docker compose logs`).

For anything touching data sources, the model or prompts, also run `pnpm brief:dry` against real data and read the output. Chat features are verified by the user in Discord; ask them to try specific commands.

## Code layout

- `src/` is split into modules (top-level folders). See `PLAN.md` section 3 for what each holds.
- Other modules import a module only through its `index.ts`, which exports only what other modules use. Files inside a module import each other directly.
- Cross-module imports use the `#/` subpath import (`package.json` `imports`, maps to `./src/*`): `from '#/infra/index.js'`. Imports inside a module stay relative (`from './rules.js'`). Tests reaching into another module's file use `#/` too (`#/archive/archive.js`); `test/helpers.js` stays relative.
- Dependencies point down only: `infra → location → schedules → sources → llm → archive → brief → chat → scheduler → app`. `eslint.config.js` (`local/module-boundaries`) enforces these rules; add new modules to its `LAYERS`.
- File and folder names are kebab-case.
- Unit tests sit next to the code they test: `src/llm/sanitize.ts` → `src/llm/sanitize.test.ts`, one test file per source file. Tests may import other modules' internal files (the boundary rule exempts `*.test.ts`; layering still applies). Shared helpers and fixtures live in `test/` (`test/helpers.ts`, `readFixture('news/rnz.xml')`).
- Match the surrounding code: small functions, comments only where the reason is not obvious, prettier formatting.
- Use **pnpm** (version pinned in `package.json` `packageManager`). Dependencies are pinned to exact versions (`saveExact` in `pnpm-workspace.yaml`); install with `pnpm install --frozen-lockfile`. Dependency build scripts are off unless listed in `allowBuilds`.

## Rules the code relies on

- **Never use the system timezone.** All "today" and clock-time logic goes through luxon in the effective location's zone (`getEffectiveLocation()`; `/city` can change it). No `new Date().getHours()` or `toLocaleString()`. This is why tests run under two TZs.
- **All runtime data lives in `data_dir`** (default `data/`, contents gitignored). Write files with `writeFileAtomic`. Nothing outside it is written at runtime.
- **Logs only through `infra/logger.ts`**, which redacts registered secrets; `console` is banned elsewhere by eslint. Errors shown to the user go through `describeError` (redacted, Chinese).
- **Data sources never throw.** They return `SourceResult` (`text` for the model, `raw` for the archive, `ok`); a failure becomes Chinese text like `（天气获取失败：请求超时）` and the brief still goes out.
- **Model input and output are untrusted.** Gathered data is wrapped in `<数据>` tags with any tags inside defused. Model output goes through `sanitizeOutput`: every URL the model wrote is removed, then news ids like `[N3]` become links from our own id map. Links in messages can only come from subscribed feeds.
- Prompts live in `src/llm/prompts.ts`; keep the copy in `PLAN.md` stage 3 in sync. After changing a prompt, compare several `brief:dry` runs.
- One instance per `data_dir` (`app.lock`); one instance serves one user. Do not add state shared across instances.
- The chat core (`chat/core/`) is platform-independent; Telegram and Discord adapters only translate messages and check the sender (`dispatch`).
