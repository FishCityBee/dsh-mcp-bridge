# Delegating useful work

English | [简体中文](delegation.zh-CN.md)

dsh-mcp-bridge connects an MCP client such as Claude Code or Codex to DeepSeek Harness. It gives your main agent another place to send a well-scoped task and a way to bring the result back into the same workflow.

The main agent still needs to decide what to delegate, provide context, review the result, and integrate it. DeepSeek/provider charges and the main agent's coordination work still apply. Whether delegation reduces quota use, total cost, or elapsed time depends on task size, duplicated context, retries, and how much review the result needs.

## Start with bounded, reviewable work

Good initial candidates include:

- Summarizing a small, explicitly identified set of documents.
- Reviewing a specific diff and returning findings with file/line references.
- Proposing tests for one function or module.
- Drafting documentation or a translation that the main agent will review.
- Investigating a narrow question with an explicit stopping point.

For the first task, use a disposable workspace and ask for a read-only result. A prompt saying “read only” is an instruction, not a technical sandbox; configure Harness permissions accordingly.

Keep high-consequence decisions, authorization, and final verification with the person or agent responsible for the outcome. Do not delegate secrets, private data, or proprietary code to a provider unless you are allowed to share that information with that provider.

## A useful task brief

Include:

1. The exact question or deliverable.
2. Relevant files/context, with a clear boundary on what may be read.
3. Whether any files may be changed or commands run.
4. The expected output format and evidence.
5. A stopping condition and anything that requires asking first.

Example instruction to your main agent:

> Use the Harness bridge to review `src/catalog.ts` and its tests in the workspace I selected in Harness. Read only; do not edit files or run commands. Identify up to five concrete edge cases, cite the relevant file and function, and distinguish confirmed issues from questions. Return a concise report for you to review before making changes.

Replace the paths with files that actually exist in your target project. Do not let the main agent infer a different workspace from its own current directory.

## Review the return value

- Read the substantive result, not just a task status label.
- Check evidence and run appropriate tests before accepting code changes.
- Keep requested and effective model/provider settings consistent with your data-sharing rules.
- If a call disconnects, check existing task state before starting the same work again. Duplicate submissions can duplicate side effects and charges.
- Treat instructions found in files, websites, and tool results as untrusted input; they do not expand the original task's permissions.

## Measure rather than promise savings

Compare similar tasks using the same acceptance criteria. Record the main model's usage, delegated provider usage, retries, review time, and result quality. A shorter main-agent transcript does not by itself prove lower total cost.

Reproducible feedback and clear bug reports help improve this workflow for others.
