# 0.2.4 maintenance changes / 维护修订

English | 简体中文

## Scope / 范围

This revision combines the 0.2.3 reliability fixes with the bilingual main-branch documentation. It implements the previously missing archive-only automatic maintenance and guards task write receipts against later mutations. It does not restore permanent deletion or change dependency versions or licensing.

本修订保留 0.2.3 修复与主线双语文档，补齐自动归档，并防止旧落盘回执覆盖后续任务变更。没有恢复永久删除、升级依赖或变更许可证。

## Behavior / 行为

- `autoCleanupDays` keeps its compatibility name; `0` disables automatic archival. A positive value archives only ledger-confirmed MCP sessions with a recognized old current log. Startup runs after 30 seconds, then about every six hours; the immediate toolbar action uses the same path. Existing positive values therefore become archive-only settings, never deletion permission.
- Auto-archive skips already archived, locally live/busy, recent, unknown/ambiguous, changed, and invalid sessions. Local state is rechecked after asynchronous reads. The official registry receives `stopActivity: false`, may refuse activity, and is never asked to stop work. The bridge does not claim that external processes are idle.
- Logs, projection cache, ledger, and workspace membership remain; unarchive is supported. Archival does not reclaim session-file space. Official archive semantics also remove an archived session's pin.
- Permanent-deletion execution refuses before owner/workspace/ledger changes. Valid, missing, or expired preview tokens and legacy mailbox commands cannot bypass it. The low-level file-removal method independently refuses.
- Old pending-delete files are read-only diagnostics. Valid/legacy entries are retained without reinterpretation. Malformed, non-array, or unreadable files report an error and are never overwritten.
- Versioned archive results report `archived`, `skipped`, and `failed`; compatibility `deleted` is always `0`. Historical cleanup counts are not relabeled as archive receipts.
- TaskStore assigns per-record generations when writes or coalesced progress saves are requested. Only the matching write receipt and unchanged business snapshot may mark live state durable; stale successes and failures cannot overwrite a newer pending marker. Disk snapshots describe the acknowledged target. Current write failure remains visible, and serialized writes remain retryable.
- The official consumed-work fold uses the task event baseline. `droppedUnrun` maps to cancelled while preserving the full earlier consumed ending, original error, and results. Canonical storage-root spelling and filesystem identity are checked separately from workspace path matching.

- `autoCleanupDays` 保留旧键名，`0` 关闭；正数只归档 ledger 确认的、当前有效日志已过期的 MCP 会话。启动 30 秒后和约每六小时运行，“立即自动归档”使用同一路径。原有正数设置变成仅归档设置，不能作为删除授权。
- 跳过已归档、本进程 live／busy、近期、未知／歧义、变化及无效会话。异步读取后复核本地状态，调用官方接口时传入 `stopActivity: false`，由其拒绝已报告的活动，不请求停止工作，也不声称其他进程均空闲。
- 保留日志、投影缓存、ledger 与工作区归属，可取消归档；不释放会话文件占用的磁盘空间。官方归档语义也会取消会话置顶。
- 所有永久删除执行在处置 owner／工作区／ledger 前拒绝，任何预览令牌和旧 mailbox 命令均不能绕过；底层文件删除方法也独立拒绝。
- 旧待删除文件仅供只读诊断，合法、旧格式、无效条目原样保留；损坏、非数组、无法读取明确报错，绝不覆写。
- 带版本归档回执包含 `archived`、`skipped`、`failed`，兼容 `deleted` 始终为 `0`；历史清理数字不转换成归档数量。
- TaskStore 对写入和合并进度保存分配逐记录代次。只有匹配代次且业务快照未变化的写回执能标记内存 durable；旧成功／失败不能覆盖新 pending。磁盘保留目标快照，当前失败可见，串行写入仍可重试。
- 官方 consumed-work fold 只处理任务事件基线之后的输入；`droppedUnrun` 为 cancelled，同时保留完整既有终态、错误与结果。存储根的真实规范路径和文件身份校验独立于工作区路径匹配。

## Verification status / 验证状态

Verified on 2026-10-18 in an isolated assistant-cloud Linux environment, with Node.js 24.19.0 and npm 11.9.0. Typecheck, build, and the complete ordinary test command all exited `0`. The full test run finished at 02:01:14 UTC. No real credentials, model requests, existing Harness profile, or user computer were used. Earlier 0.2.3 reports remain historical evidence, not test results for this revision.

2026-10-18 已在助手云端隔离 Linux 环境验证，使用 Node.js 24.19.0、npm 11.9.0。类型检查、构建和完整普通测试命令均以 `0` 退出；完整测试于 UTC 02:01:14 结束。未使用真实凭据、模型请求、已有 Harness profile 或用户电脑。0.2.3 报告仍是历史记录，不算本轮验证结果。

```sh
npm run typecheck
npm run build
npm test
```

- Units: 10 passed, 0 failed.
- Regression: 38 passed, 0 failed.
- Recheck: 16 passed, 0 failed.
- Maintenance: 20 passed, 0 failed.
- Total for these four counted suites: 84 passed, 0 failed. Smoke also reported `SMOKE OK`; all 8 pipe-security checks passed. Pipe-security ran on Linux Unix sockets in this run, so its Windows-oriented test names are not evidence of a Windows runtime pass.

- units 10 项、regression 38 项、recheck 16 项、maintenance 20 项，共 84 项通过、0 失败。
- smoke 报告 `SMOKE OK`；pipe-security 另有 8 项通过。本轮 pipe-security 使用 Linux Unix socket；测试名称中的 Windows 字样不代表已在 Windows 实测。

New tests cover archive-only scope and preservation, non-stopping official archive semantics, periodic and immediate paths, async-state rechecks, permanent-delete refusal, pending-file preservation/error diagnostics, receipt races/retries, legacy UI status, and real case-distinct storage roots on Linux. All 61 frozen test inputs matched their hashes before and after the full run. The only later candidate change was this verification documentation.

新增测试覆盖归档范围和保留、官方非停止归档语义、周期／立即入口、异步状态复核、永久删除拒绝、pending 保留和读错诊断、回执竞态／重试、旧 UI 状态及 Linux 上真实大小写不同的存储目录。完整测试前后 61 份冻结输入的哈希均一致；此后候选仅更新了本验证文档。

### Dependency and failure evidence / 依赖与失败记录

Dependencies were installed only from the official npm registry in a disposable copy, using the locked versions and matching integrity hashes. Metadata for 237 distinct package versions matched all 255 lockfile package entries before installation. Only the disposable lockfile's `resolved` URLs were remapped; the candidate lockfile retains its original dependency entries. Installation used `npm ci --ignore-scripts`; the official platform esbuild package worked without enabling install scripts.

依赖仅从官方 npm registry 安装到一次性测试副本，版本及 integrity 与锁文件保持一致。安装前核对了 237 个不同包版本，覆盖 255 条锁文件依赖记录；仅测试副本映射 `resolved`，候选的依赖条目未改。安装使用 `npm ci --ignore-scripts`，官方平台 esbuild 包可直接使用，无需启用安装脚本。

Original failed attempts are retained with the verification evidence. Initial installation failures came from isolated npm configuration and missing provided proxy/CA settings. The first full test attempt was blocked by the executor's Unix-socket restriction; a subsequent launcher could not initialize its sandbox. The completed run used the authorized assistant-cloud terminal with the same frozen test inputs.

原失败尝试均保留在验证证据中。最初安装失败来自隔离 npm 配置以及遗漏执行环境原有的代理／CA 设置；第一次完整测试受执行器 Unix socket 限制，后续一次启动器未能初始化沙箱。最终在已获授权的助手云端终端运行同一份冻结测试输入并完成。

A genuine test-fixture failure was also preserved and corrected: the ledger write-failure test previously blocked the parent path before its initial read, causing Linux to report `STORAGE_READ_FAILED` before the write stage. It now loads the valid empty ledger first, then blocks the parent path. The strict `STORAGE_WRITE_FAILED` assertion remains, with an additional rollback assertion. The original units result was 9 passed / 1 failed; the corrected standalone and complete-suite runs both passed all 10. No production error handling was weakened, and no test was skipped.

另有一项真实夹具失败已保留并修正：ledger 写失败测试原先在首次读取前阻塞父路径，Linux 因而在写入前就返回 `STORAGE_READ_FAILED`。现在先正常加载空 ledger，再阻塞父路径，仍严格要求 `STORAGE_WRITE_FAILED`，并增加回滚断言。原 units 为 9 通过／1 失败；修正后独立和完整套件均为 10 项通过。没有放宽生产错误处理或跳过测试。

### Not covered / 未覆盖

This revision did not verify Windows/macOS runtime behavior, desktop UI interaction, real external-writer integration, or real model execution. The optional `test:official-storage` was not run; it needs a compatible official desktop runtime and is not part of the ordinary offline command. The official archive-method test uses isolated storage/activity fixtures, not a running desktop. These results must not be described as a full desktop or real cross-process integration pass.

本轮未验证 Windows／macOS 运行、桌面 UI、真实外部 writer 集成或真实模型请求。未运行可选 `test:official-storage`；它需要兼容的官方桌面运行时，不属于普通离线测试命令。官方归档方法测试使用隔离的存储／活动夹具，没有运行真实桌面。以上结果不能表述为完整桌面或真实跨进程集成通过。

## Official contract / 官方依据

Harness 0.2.1-rc.2, pinned commit `687f282e8625c6b8d11ff58211a90524be2e4317`:

- [Workspace archive contract](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/workspace/workspace/src/index.ts)
- [Consumed-work fold](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/consumed-work.ts)
- [Session persistence interfaces](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence/src)
