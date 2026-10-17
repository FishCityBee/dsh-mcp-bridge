# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping improve dsh-mcp-bridge. Useful contributions include reproducible bug reports, documentation, translations, compatibility checks, tests, and focused fixes.

## Before opening an issue

- Search existing [issues](https://github.com/FishCityBee/dsh-mcp-bridge/issues) first.
- Include the bridge commit or version, Harness version, operating system, Node.js version, and MCP client/version.
- Describe the expected and actual behavior, then provide the smallest safe reproduction you can.
- Use a disposable workspace and synthetic data for tests involving file changes, permissions, cancellation, or session cleanup. Do not reproduce destructive behavior against your real session history.
- Remove tokens, provider credentials, private prompts, local usernames, private paths, and sensitive file contents from logs and screenshots. Share only the relevant excerpt.
- Do not post vulnerability details in a public issue. Follow [SECURITY.md](SECURITY.md).

English and Chinese reports are both welcome. You do not need to translate your report into both languages.

## Development workflow

1. Fork the repository and create a focused branch.
2. Read the code you will change, including the affected tests and the matching Harness API contract.
3. Install the locked dependencies and run the available checks in a development environment:

   ```sh
   npm ci
   npm run typecheck
   npm test
   ```

   `npm test` builds the bundle and runs the smoke, unit, regression, and temporary-pipe security suites. Passing those tests alone does not establish compatibility with a real Harness installation, every MCP client, or every operating system.

4. Add regression tests for behavior changes. Cover both a successful path and relevant failures.
5. Update the English and Chinese documentation together when user-facing behavior changes.
6. Open a pull request with the problem, approach, checks run, and any checks you could not run.

Do not describe a check as passing unless you ran it on the submitted revision. Distinguish static inspection, mocked/offline tests, and live integration checks.

## Changes that need extra care

- **Task lifecycle:** cancellation while queued or starting, concurrent work in the same session, disconnect/reconnect, restart, and terminal failure reporting.
- **Model routing:** actual provider/model/reasoning used for new and continued sessions, not only task metadata.
- **Permissions:** MCP client approval and Harness execution approval are separate. Never silently broaden either boundary.
- **Session maintenance:** preview/execution consistency, preserved active sessions, scope filters, last-activity accuracy, and containment of filesystem paths.
- **Persistence:** concurrent writes, interrupted writes, retention, and recovery when the data directory is unavailable.
- **Frontend:** repeated edits, out-of-order responses, and visible errors.

Use temporary directories and synthetic records for deletion and recovery tests. Keep real credentials and personal Harness data out of tests and fixtures.

## Pull request scope

Keep each PR focused enough to review. Explain user-visible changes and compatibility implications. Include screenshots only when they help explain a UI change, with private information removed.

Do not add badges that imply unverified test results, measured savings, official endorsement, or supported platforms. Performance and cost claims need a reproducible method and stated conditions.

## License

This repository uses the existing [MIT License](LICENSE). Keep copyright and license notices intact. Do not include code, assets, or data you do not have permission to contribute.
