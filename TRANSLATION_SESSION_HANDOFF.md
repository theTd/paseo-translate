# 翻译插件隐藏会话重构交接文档

## 交接目标

用户要求把所有需要翻译的文本交给“每个主 Agent 会话自己的隐藏翻译会话”处理：

- 同一主 Agent 会话的翻译请求严格串行；
- 不同主 Agent 会话之间允许并发；
- 翻译指令和翻译结果不能进入主 Agent transcript；
- 同一翻译会话持续使用稳定的 `prompt_cache_key`；
- 上下文压缩、模型、端点或语言设置变化时递增 `cacheEpoch`；
- ACP、Claude、Codex 使用各自真正独立的隐藏 session/thread；
- provider 无法提供安全隐藏会话时才回退 HTTP。

## 当前 Worktree

当前独立 Worktree：

```text
C:\Users\cui\.codex\worktrees\translation-session-refactor\paseo-translate-plugin
```

原始 Paseo 工作目录已经恢复干净，后续修改只能在上述 Worktree 进行。

## 已完成

### 1. 每主会话调度器

文件：`server/translation-session.ts`

已实现：

- `TranslationSessionManager` 按 `sessionKey` 创建和复用 session；
- 同一个 session 内最多一个 endpoint 任务运行；
- `prompt` 队列优先于尚未开始的 `display` 队列；
- 不同 session 使用不同队列，可以并发；
- 支持取消、关闭、队列上限和空闲回收；
- `cacheEpoch` 和配置 fingerprint；
- `stats()` 可接入 memory probe。

测试：`server/translation-session.test.ts`

### 2. 翻译路径接入 session 调度

文件：`server/translate.ts`

已接入：

- prompt unary completion 进入 `prompt lane`；
- display stream 进入 `display lane`；
- display batch 也进入 `display lane`；
- session 配置变化会递增 epoch；
- 排队执行时重新读取当前 translation context，避免使用过期快照；
- 使用 session 的 `promptCacheKey`；
- 没有 session manager 时保留原有 hermetic 测试行为。

### 3. HTTP backend 抽象

文件：`server/translation-backend.ts`

已实现：

```ts
interface TranslationBackend {
  readonly kind: "http" | "acp" | "claude" | "codex";
  complete(request): Promise<string>;
  stream(request): Promise<string>;
  close(): Promise<void>;
}
```

`createHttpTranslationBackend()` 是当前默认实现，复用现有 `LlmClient`。

`TranslatorDeps.backendFactory` 已接入 `server/translate.ts`；provider 可以注入真正的隐藏 backend。当前 `index.server.ts` 仍默认注入 HTTP backend。

### 4. Claude adapter 草稿

文件：`server/claude-translation-backend.ts`

这是一个 provider-specific adapter 草稿：

- 为每个 translation session 创建独立 Claude SDK `query()`；
- 将 `ChatMessage[]` 序列化为独立 user message；
- 收集 `result` 或 assistant text block；
- 支持 delta 和 interrupt；
- 不复用主 Claude query。

它尚未接入 `createTranslateClaudeProvider()` 的 session 生命周期，也还需要基于现有 `ClaudeSession.config` 完整构造 SDK `Options`。

### 5. Claude 隐藏 session 接入（本次接手已完成）

`server/claude-provider.ts` 现已为每个 Claude 主 session 创建并缓存独立 translation backend：

- 使用独立 SDK `query()`、独立 `AbortController` 与 `persistSession: false`；
- 翻译 query 不复用主 session 的 `query`、`sink`、pump 或 transcript；
- 主 session 关闭时关闭对应隐藏 query；
- 工具调用、权限事件和非成功 result 会使 backend 失败；
- hidden backend 失败时翻译路径回退 HTTP；
- `server/translation-backend.test.ts` 覆盖纯文本、delta、close 和工具事件拒绝。

## 明确未完成

### Claude

需要在 `server/claude-provider.ts` 中：

1. 将 `ClaudeSession` 的 session 配置暴露给 translation backend factory；
2. 用主 session 的 executable、cwd、env、model、provider options 创建隐藏 query；
3. 为隐藏 query 使用独立 `AbortController`、独立 SDK transcript 和独立 query pump；
4. 只允许文本结果回到翻译器；工具调用、权限请求、图片和非文本事件必须视为 backend error；
5. 主 session 关闭时关闭对应隐藏 query；
6. 隐藏 query 崩溃时销毁 backend、递增 epoch、重新创建，不能把请求转发到主 query。

重点代码位置：

- `createTranslateClaudeProvider()`：约 335 行；
- `ClaudeSession`：约 240 行；
- `ensureQuery()`：约 1610 行；
- `ClaudeQueryFactory`：文件顶部约 110 行；
- `pumpQuery()`：约 2415 行。

### Codex

需要在 `server/codex-provider.ts` 中：

1. 用主 session 的 executable、cwd、env 和 provider options 创建独立 Codex app-server client；
2. 对隐藏 session 调用独立 `thread/start`；
3. 对每次翻译调用独立 `turn/start`；
4. 只收集该隐藏 thread 的 assistant text item；
5. 不能复用主 session 的 `CodexClientLike`，因为其 notification handler 和 turn 状态属于主 thread；
6. 隐藏 client/thread 关闭时调用 `dispose()`；
7. thread 创建失败、事件不完整或结果包含工具调用时回退 HTTP。

重点代码位置：

- `server/codex-app-server.ts` 的 `CodexClientLike`；
- `createRealClient()`：`server/codex-provider.ts` 约 2500 行；
- `createThread()`：约 744 行；
- `turn/start`：约 1029 行；
- notification 解析：约 1260 行以后。

### ACP

ACP 最复杂。主 ACP provider 的 inner agent 是在 `server/acp-connector.ts` 中通过 `spawn()` 启动的子进程。

需要：

1. 为每个主 ACP session 创建独立的 ACP child process；
2. 对独立 process 发送 `initialize` 和 `session/new`；
3. 只发送翻译 prompt，不发送工具、权限或用户可见事件；
4. 解析 `session/prompt` 对应的纯文本结果；
5. 关闭主 session 时关闭隐藏 child process；
6. 如果 inner agent 不支持独立 session、响应格式不完整或出现工具/权限事件，立即销毁并回退 HTTP。

重点代码位置：

- `server/provider.ts` 的 `createTranslateProvider()`；
- `server/acp-connector.ts` 的 `createTranslatingAcpStream()`；
- `server/acp-session-env.ts`；
- `server/acp-connector.ts` 中 `session/new`、`session/load`、`session/prompt` 重写逻辑。

不能把主 ACP proxy 的 stream 复用给翻译 session，因为它会把翻译请求混入主 ACP 协议流。

## 重要设计约束

### 不要把隐藏翻译请求发到主 Agent

以下做法都是错误的：

- 在主 Claude query 上追加翻译 user message；
- 在主 Codex thread 上调用额外 `turn/start`；
- 在主 ACP stream 上伪造一个翻译 prompt；
- 只靠 `prompt_cache_key` 伪造隐藏 session。

这些做法都会污染主 transcript，或者让主 Agent 看到翻译指令。

### `prompt_cache_key` 的作用

`prompt_cache_key` 只是上游缓存亲和标识，不会创建 session，也不会自动保存 transcript。

当前派生规则：

- 基础 key 来自主 session scope；
- 同一 `cacheEpoch` 内稳定；
- 配置变化时递增 epoch；
- epoch 变化后使用新 key；
- 上游不支持该字段时仍需正常工作，但不能假设命中缓存。

### 取消语义

- 取消一个等待者不应立即中止共享 endpoint 请求；
- 最后一个 waiter 离开时才 abort；
- 隐藏 backend 的 abort 必须只影响该 translation session；
- 不能调用主 Agent 的 interrupt。

## 已知验证结果

在迁移到独立 Worktree 前：

- `npm run typecheck` 通过；
- 相关 session/backend/translate 测试通过；
- 相关测试合计 64 个通过；
- `npm run build` 通过；
- Claude bundle daemon evaluation 验证通过。

迁移后的 Worktree 没有独立 `node_modules`，直接执行检查会遇到依赖路径问题。原目录依赖仅用于只读验证，不能继续写原目录。

## 推荐接手顺序

1. 先完成 Claude hidden backend，并把 `server/claude-translation-backend.ts` 接入 provider session 配置；
2. 为 Claude 增加 fake query 测试：纯文本成功、工具事件拒绝、interrupt、close、主 query 隔离；
3. 完成 Codex 独立 client/thread backend；
4. 完成 ACP 独立 child process backend；
5. 在 `server/translate.test.ts` 增加 backend factory contract 测试，确认 provider backend 被调用、HTTP 只在 factory 缺失/能力失败时使用；
6. 增加 transcript isolation 集成测试；
7. 更新 README 和计划完成状态；
8. 运行 `npm run typecheck`、定向 Vitest、`npm run build` 和完整测试；
9. 不要自动 commit，等待用户明确确认。

## 当前结论

调度层、缓存 epoch、HTTP fallback 和 provider backend 注入点已经存在；真正的 Claude/Codex/ACP 隐藏 session 还没有完成。后续接手者必须从 provider 生命周期继续实现，不能把现有 HTTP backend 或 adapter interface 当成最终交付。
