# 翻译会话重构计划

> 实施状态：阶段 1、阶段 2 已落地；阶段 3 的 `cacheEpoch`、配置变更轮换和诊断统计已接入。ACP/Claude/Codex 的安全隐藏 provider session 仍按后端能力选择，当前统一回退到 HTTP session backend。

## 目标

为每个主 Agent 会话建立一个独立的翻译会话：同一主会话内的翻译请求严格串行，不同主会话之间允许并发。翻译会话与主 Agent 会话隔离，主 Agent 只接收最终译文，翻译过程不会污染主 Agent 的任务上下文。

重构后应满足：

- 用户输入翻译成功后才发送给主 Agent；翻译失败时 fail-closed。
- 同一 `sessionKey` 的翻译请求按提交顺序执行。
- 不同 `sessionKey` 之间不互相阻塞。
- 显示翻译不会阻塞用户输入翻译。
- 同一翻译会话持续使用稳定的 `prompt_cache_key`。
- 上下文压缩、模型切换或系统提示词变化时，通过 `cacheEpoch` 明确开启新的缓存前缀。
- 上游不支持隐藏会话或 prompt cache 时，仍可使用 HTTP 翻译后端完成工作。

## 目标架构

```text
主 Agent 会话 A
├── 主 Agent A
└── TranslationSession A
    ├── prompt lane（高优先级、严格串行）
    └── display lane（低优先级、可取消）

主 Agent 会话 B
├── 主 Agent B
└── TranslationSession B
    ├── prompt lane
    └── display lane
```

A 与 B 可以并发；同一会话内的两个 lane 共享会话上下文，但 prompt lane 具有优先权，display lane 不得长期占用发送所需资源。

翻译会话由统一接口表示，provider 差异只存在于后端适配层：

```ts
interface TranslationSession {
  translate(input: TranslationInput): Promise<string>;
  translateStream?(
    input: TranslationInput,
    onDelta: (delta: string) => void,
  ): Promise<string>;
  close(): Promise<void>;
}

interface TranslationSessionFactory {
  getOrCreate(sessionKey: string): Promise<TranslationSession>;
}
```

首个后端使用现有 OpenAI-compatible HTTP endpoint。后续可增加 ACP、Claude 和 Codex 的隐藏会话后端；这些实现不能进入上层翻译逻辑。

## 关键设计

### 会话身份

- `sessionKey` 是主 Agent 会话与翻译会话的一对一关联键。
- ACP 使用稳定的内部 ACP session id；直接 Claude/Codex provider 使用各自稳定的 transcript/thread id。
- 没有会话身份的独立翻译继续走无上下文的短生命周期 session。
- 会话 manager 负责创建、复用、空闲回收和关闭。

### 串行与并发

- 每个 `TranslationSession` 内维护一个 FIFO 队列。
- prompt 与 display 使用独立队列；prompt 队列可以抢占尚未开始的 display 工作。
- 同一文本的请求先进入 single-flight，避免重复 endpoint 调用。
- 跨 session 的并发上限由全局资源闸门控制，但不能把所有 session 合并成一个全局 FIFO。
- 取消只移除当前等待者；只有没有其他等待者时才终止实际 endpoint 请求。

### 上下文与缓存

每个翻译会话维护不可变追加的翻译记录：

```text
system prompt
user-translation-1 -> assistant-translation-1
user-translation-2 -> assistant-translation-2
...
```

- 不在请求之间重新排序历史记录。
- prompt 翻译和 display 翻译不能互相写入对方的上下文，除非明确属于同一翻译 transcript。
- `prompt_cache_key` 由 `sessionKey + cacheEpoch` 派生，同一 epoch 内保持不变。
- 上下文压缩、模型/端点/语言设置变化时递增 `cacheEpoch`。
- 压缩后的快照成为新前缀起点，旧 epoch 不再继续追加请求。
- 精确文本缓存仍保留，但缓存键必须包含语言对、系统提示词、后端配置和 session 身份。

### Provider 后端

1. **HTTP session backend**
   - 复用现有 `createLlmClient`。
   - 以会话 transcript 生成稳定前缀。
   - 默认使用 stream-first；prompt lane 可使用完整结果模式。
   - 上游返回 JSON、拒绝 SSE 或不支持 `prompt_cache_key` 时保持兼容。

2. **ACP session backend**
   - 每个主 session 创建一个隐藏 ACP session。
   - 翻译指令只发送到隐藏 session，不进入主 Agent transcript。
   - 只提取明确的纯文本结果；工具调用、权限请求和非文本事件视为后端错误。

3. **Claude/Codex session backend**
   - 在协议具备独立 session 能力时实现隐藏 session。
   - 如果 provider 没有安全的隐藏 session 能力，回退到 HTTP session backend。
   - 不能把翻译指令发送到主任务会话。

## 实施阶段

### 阶段 1：建立会话抽象

- 新增 `server/translation-session.ts`：接口、状态机、关闭语义和错误类型。
- 新增 `server/translation-session-manager.ts`：按 `sessionKey` 创建、复用、回收会话。
- 把现有 `translation-context` 的 session scope 接到 manager，但暂时保留 HTTP endpoint 行为。
- 为会话状态增加 `cacheEpoch`、`lastActivityAt` 和 backend 类型。

验收：现有翻译行为不变；同一 session 的请求可观察到同一个 session 对象和稳定 cache key。

### 阶段 2：迁移请求调度

- 将 `createTranslator` 的 endpoint 工作改为通过 `TranslationSession` 调度。
- 实现每 session FIFO；保留跨 session 全局并发闸门。
- 分离 prompt lane 和 display lane。
- 保留现有 single-flight、取消和缓存语义。

验收：同一 session 的请求顺序稳定；两个 session 可同时执行；display 队列不会阻塞 prompt。

### 阶段 3：缓存与上下文重构

- 将 `prompt-cache-key` 改为基于 `sessionKey + cacheEpoch`。
- 在上下文压缩、配置变化和 provider 切换处递增 epoch。
- 增加 endpoint request id、session key、epoch、cache key 和队列等待时间的诊断字段。
- 明确区分精确翻译缓存、会话 transcript 和上游 prompt cache。

验收：连续请求使用相同 key；epoch 变化后使用新 key；缓存命中和未命中可从诊断日志区分。

### 阶段 4：接入隐藏 provider session

- 先实现 ACP hidden session，并验证纯文本提取和异常关闭。
- 再评估 Claude/Codex 的独立 session 能力。
- 无法安全隔离的 provider 继续使用 HTTP session backend。

验收：隐藏翻译结果不会出现在主 Agent transcript、工具调用记录或用户可见回复中。

### 阶段 5：清理旧路径

- 删除调用方对 `translation-context`、`translation-inflight` 和 `translation-upstream` 的直接编排。
- 由 session manager 统一暴露调度、取消、统计和生命周期接口。
- 更新 README，说明真实的翻译会话、缓存 epoch 和 provider 回退策略。
- 删除已失效的 stream/unary 分支测试和注释，补齐新的 session contract 测试。

## 测试计划

- 单元测试：同 session FIFO、跨 session 并行、display 不阻塞 prompt、取消最后一个 waiter 时才 abort。
- 缓存测试：同 epoch 稳定 key、epoch 变化换 key、配置变化使旧缓存失效。
- 上下文测试：压缩前后 transcript 顺序、重启恢复、不同 session 不串上下文。
- provider contract 测试：所有 backend 都能创建、复用、关闭会话；隐藏 backend 不产生工具调用。
- 集成测试：ACP、Claude、Codex 主会话收到的只有最终译文；翻译失败不会把原文发送给主 Agent。
- 压力测试：多个 session 并发时单 session 顺序不乱，队列和内存有上限。

## 风险与回退

- 上游不支持 prompt cache：继续运行，但诊断中明确标记为 unsupported；不能假设缓存命中。
- provider 不支持隐藏 session：自动回退到 HTTP session backend。
- 隐藏 session 崩溃：销毁该 session、递增 epoch、重新创建；不重放到主 Agent 会话。
- 队列堆积：prompt 保留有限等待容量；display 可丢弃并在下次渲染时重试。
- 会话上下文过大：按 epoch 执行压缩，并保留最近翻译对和压缩摘要。

## 完成标准

只有同时满足以下条件，才认为重构完成：

- 同一主 Agent 的所有翻译请求都归属于同一个可追踪的翻译 session。
- 同一 session 内严格串行，跨 session 保持并发。
- 主 Agent transcript 中不存在翻译指令和隐藏翻译结果。
- prompt cache key 在同一 epoch 内稳定且可观测。
- provider 不支持隐藏 session 时仍能正常翻译。
- 现有 ACP、Claude、Codex 和显示翻译测试全部通过。
