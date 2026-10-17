# 0.2.3 复审修复记录

日期：2026-10-18。修复分支：`fix/reliability-audit-20261017`。

本轮基于实际本地、已推送的 `6dca66e1b099d4bcd50860a25c26496ecc770dce`（0.2.2）。原仓库工作区干净，修改在隔离副本完成；没有覆盖用户改动。附件首行是该 SHA，正文方法段另有 `78b5196…`，本轮结论仅针对实际核对的 6dca66e 及本轮代码。附件提及的 `security_recheck.md` 未提供，不把其内容当作已读证据。

官方依据为 Harness **0.2.1-rc.2**，标签提交 `687f282e8625c6b8d11ff58211a90524be2e4317`；本地官方依赖及桌面实际 JSONL 后端均为 0.2.1-rc.2。没有修改依赖版本，也没有新增授权缓存或改变权限预设。

| 项目 | 0.2.2 实际结论 | 0.2.3 处理及证据 |
|---|---|---|
| R1 跨进程 writer 与永久删除 | 仍存在。桌面进程的 agents/busy 表看不到其他 CLI/SDK writer；`stat/revision` 不提供排他性 | 禁止手动、批量、自动、启动 pending 四条执行路径实际删文件。请求不再 dispose、停止、分离或取消置顶；不新增 pending。UI 禁用删除和自动清理，工具描述及 status 明示不可用。归档、取消归档、只读预览保留 |
| R2 `droppedUnrun` | 仍存在。只读 `.end`，漏掉“无 end 的未运行输入取消”和“completed 后又丢弃未运行输入” | 同时处理官方 fold 的 `.end`、`.droppedUnrun`；后者为 true 时记 `cancelled`，termination 保存 `droppedUnrun` 和已有 `consumedEnd`。后续已消费完成仍按官方 fold 重置为 done |
| R3 落盘 `pending` | 仍存在。业务终态已经写盘，但快照保存的是瞬时 pending 标记 | 序列化目标快照为 durable，成功 rename 前不修改 live 对象；读到的旧进程 pending/degraded 标记归一为该已存快照 durable。写入失败仍显式 degraded；没有把快照标记等同于更晚的未写修改 |
| C1 大小写与存储根 | 仍存在。所有平台 lowercase 可能合并 POSIX 两个不同目录 | Windows 使用 win32 路径规则，POSIX 保留大小写；存储根经 realpath、既有链接边界和 dev/ino 文件身份共同核对，不能只依赖字符串前缀 |

## R1 的能力边界

官方 `SessionPersistence` 接口仅有 create/open/flush/stat/list，没有受支持的原子删除接口。官方明确说明 stat 不取得 ownership，owner 取得/释放不会改变 revision。写租约用于单写者互斥，不能把“取得 lease 再递归 rm”解释为能阻止删除期间的新 owner：删除锁 inode 或依赖不会阻止目录删除的 Windows 信号量，仍有协议缺口。

因此本轮解决方案是**停用永久删除**，并未实现跨进程原子删除。所有执行分支均无法到达文件删除，`SessionFiles.remove` 也设有独立拒绝屏障。单个无效 ID、存储边界、busy 或过期确认仍可先报相应错误；通过这些校验的删除请求返回 `PERMANENT_DELETE_UNSUPPORTED`。

旧 `autoCleanupDays` 不被静默改写，但不再注册自动删除计时器；UI 仅显示历史天数并标注停用。旧 pending 文件原样保留，启动五秒只输出非敏感诊断；即使 MCP 开关关闭也不执行删除。将来只有官方支持原子删除、删除标记或等效完整存储协议时，才能单独设计、测试并重新开放该功能。归档保存文件，也不承诺停止另一个进程。

## 回归、命令与结果

先补 `tests/recheck.mjs`，对未修复逻辑得到 **1 通过 / 7 失败**，包括 R1、R2、R3 和 C1 的反例。原始日志单独交付，未用旧 smoke 通过作为关闭理由。

本轮实际命令（Windows PowerShell，Node 22.14.0）：

```powershell
npm run typecheck
npm test
$env:DSH_DESKTOP_EXE='D:\Program Files\Deepseek Harness\DeepSeek Harness.exe'
npm run test:official-storage
```

- typecheck：退出 0。
- build：由 `npm test` 的 `node build.mjs` 执行，退出 0，生成 0.2.3 安装包。
- `npm test`：退出 0，共 **97 项**：smoke 33、units 10、regression 38、pipe-security 8、recheck 8。
- 官方存储集成：退出 0，**4 项**。实际 Windows 桌面 JSONL/native lease，Electron 44.7.0 / Node 24.21.0；测试代码严格要求 backend 0.2.1-rc.2。

新回归使用官方 `foldConsumedWork` 和精确 `agent/inbox/spliced` 的 `removedCount:1, inserted:[], outcome:'canceled'` 尾段；前两个取消案例根本不调用模型流水线，不是先造一个 turn 再写 aborted。包含前序 completed 和后续消费完成的两个方向。

R3 直接检查成功 flush 后磁盘终态和 durability，并创建新的 TaskStore 冷加载；另测旧 pending 的迁移。既有“终态写入失败仍报告 degraded”回归保留并通过。

官方存储测试在**新建临时 DSH_HOME** 启动两个独立 Electron Node 进程，一个持写 handle，另一个观察并尝试写入；桥接所在进程看不到这个 agent。验证第二 writer 被官方 `SessionAlreadyOwnedError` 拒绝、stat 仍可读取；归档/取消归档不丢失该租约；手动、批量、自动/mailbox 和启动 pending 均保留日志、成员关系和原 pending。随后验证 owner churn 不改变 revision，原 writer 仍可追加两个真实日志事件、flush、释放，第二 writer 随后可以接管。

该集成的存储和 lease 是官方实现，workspace registry/UI 是测试夹具，不能称为桌面 UI 点击或完整 UI 恢复联调。没有调用模型，没有读取真实会话、凭据或私密日志，所有破坏性回归都在新建临时目录中。

## 现有测试的调整原因

没有删除原有测试，也没有放宽“越界、取消、路由、状态、失败可见”等断言。原来期待“永久删除成功”的场景，按新产品能力改为明确拒绝并检查文件、成员关系和 owner 未变；固定 ID 的确认测试改用仍可执行的归档，同时保留删除的范围预览、版本变化和缺令牌拒绝测试。

smoke 的假 backend 原来只声明 root 字符串、并未创建根目录；新增真实路径/文件身份核对后，为该临时夹具创建实际根目录，没有削弱 guard。官方新测试最初误将可选 `stat.eventCount` 当必有字段，改为独立官方 read handle 核实两个事件，保留精确计数断言。测试 worker 退出时显式关闭 stdin 并设退出等待上限，避免测试辅助进程残留。

## 修改文件

- `src/deletion.ts`、`src/session-files.ts`、`src/index.ts`：四路删除停用、独立存储层屏障、诊断及工具回执。
- `src/paths.ts`、`src/index.ts`：平台路径与实际存储根身份核对。
- `src/index.ts`、`src/tasks.ts`：droppedUnrun 终态、目标快照 durability 与冷恢复。
- `src/client/index.tsx`、`src/client/cleanup.tsx`：删除入口、批量动作及自动清理显示与后端一致。
- `tests/recheck.mjs`、`tests/official-storage.mjs`、`tests/official-session-worker.mjs`：新增反例及真实跨进程存储测试。
- `tests/smoke.mjs`、`tests/regression.mjs`：保留原场景，验收禁用后的数据保留行为。
- `package.json`、`package-lock.json`、`build.mjs`、`README.md` 与本文：0.2.3 元数据、执行入口和说明。

## 未覆盖与建议手工验证

1. 仅实测 Windows。Linux/macOS 的大小写策略有纯逻辑回归，未执行这两种系统的实际文件系统、桌面 host/relay 或权限 UI 验证。
2. R2 验证了官方消费事件语义，未在真实桌面 UI 人工制造取消尚未消费输入的竞态。
3. 本轮不重做模型、权限或 TLS 的平台全集成验收；既有离线相关回归仍通过。单次允许、持续预设和 MCP 调用许可的边界保持不变。
4. 桌面升级后可只读调用 `harness_status`，检查版本 0.2.3、`permanentDeletion.supported:false`、`pendingProcessing:false`、`automaticCleanupActive:false`，并确认模型、权限预设与升级前一致。
5. 在界面确认永久删除与自动清理不可用，归档/取消归档仍可使用。需要交互验证时新建专用测试会话；不要用真实重要会话做删除测试。
6. 尚未实现安全永久删除，也未发布 npm、合并或推送 main、创建 release、变更系统安全权限。

上游来源：[存储接口](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence/src)、[JSONL 后端](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/src/index.ts)、[官方消费尾段](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/consumed-work.ts)。
