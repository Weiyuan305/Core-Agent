# Control Plane Contracts v1 设计规格

> 状态：设计已确认  
> 日期：2026-08-03  
> 范围：Core-Agent 后台核心协议，不包含运行服务、数据库、Web 或具体 MCP 工具

## 1. 目标

在继续开发 Control Plane Runtime、Identity、Entitlement、MCP Gateway、
Composite Memory 和 Web 之前，先建立一个独立、版本化、可执行验证的
`@core-agent/contracts` 协议包。

该协议包是以下系统之间的唯一共享事实来源：

- Core-Agent Control Plane；
- Hermes 产品运行时与平台 Policy；
- 第一方 TypeScript MCP Server；
- 保留原语言的 Python 或其他领域服务；
- 未来 Web、macOS、iPhone 和 iPad 客户端；
- 审计、评估和恢复工具。

完成后，后续服务不得各自重新定义 Tenant、Actor、Membership、Profile、
Container、TrustedRequestContext、ProductEvent、AuditEvent 或 ErrorEnvelope。

## 2. 本阶段边界

### 2.1 纳入范围

1. 通用 ID、时间、版本、分页、幂等、Trace 和错误类型；
2. Tenant、Actor、Membership 和 Profile；
3. RuntimeContainer、Conversation、Session、AgentRun、Task 和 Approval；
4. TrustedRequestContext 的 Payload 与签名传输边界；
5. ProductEvent、AuditEvent 和 ErrorEnvelope；
6. 资源状态机和跨资源不变量；
7. TypeScript 类型、运行时 Schema 和标准 JSON Schema；
8. 合法/非法 fixtures、兼容性快照和契约测试；
9. MCP 后续接入规则，但不实现 MCP Gateway 或业务工具。

### 2.2 不纳入范围

- Supabase 表、迁移或任何持久化实现；
- 登录、OAuth、密码、会话签发和账户恢复；
- 购买、套餐、席位分配和实际 Entitlement 计算；
- Docker 容器控制器、调度、休眠、升级和恢复实现；
- Hermes Plugin、Composite Memory 或 Skill Registry；
- Web、Apple 客户端或 OpenAPI 服务端；
- EduApply、雅思、租房、签证或 auto-apply 的具体 Tool Schema；
- MCP SDK 依赖、空 MCP Server 或占位工具。

“完整后台协议”在本规格中表示完整完成 `Control Plane Contracts v1`，
不表示一次性交付全部后台运行服务。

## 3. 技术形态

### 3.1 包结构

```text
packages/contracts/
├── src/
│   ├── common/
│   ├── tenant/
│   ├── profile/
│   ├── runtime/
│   ├── request-context/
│   ├── events/
│   ├── approval/
│   ├── audit/
│   └── index.ts
├── schemas/v1/
├── fixtures/v1/
└── tests/
```

包名为 `@core-agent/contracts`。实现语言采用 TypeScript，Schema 定义采用
TypeBox，使同一份声明同时提供：

- TypeScript 静态类型；
- Node 运行时校验；
- 标准 JSON Schema；
- Python、OpenAPI 和未来 Swift 代码生成的语言中立输入。

第一方新 MCP Server 默认使用 TypeScript 并直接依赖该包。协议仍保持语言
中立；已有成熟 Python 服务读取生成的 JSON Schema，不因技术统一而重写。

### 3.2 唯一事实来源

- TypeBox 源文件是协议的作者源；
- `schemas/v1/` 是可分发、提交 Git 的生成产物；
- CI 必须验证重新生成后无差异；
- OpenAPI、数据库模型和 Swift 类型只能引用或生成自该协议，不能成为第二套
  作者源；
- 不使用只能存在于 TypeScript、无法表达为 JSON Schema 的隐藏转换语义。

### 3.3 Wire Format

- JSON 字段统一使用 `snake_case`；
- 时间统一使用带 `Z` 的 UTC RFC 3339 字符串；
- ID 对消费者是不可解析的不透明字符串；
- 顶层协议对象包含整数 `schema_version: 1`；
- 资源包含正整数 `resource_version`，用于乐观并发和审计关联；
- 可选字段缺失与显式 `null` 含义不同，默认使用缺失，不滥用 `null`；
- 密钥、Token、完整学生资料和付款信息不能进入通用协议对象或 fixtures。

## 4. 身份与租户模型

### 4.1 Tenant

Tenant 是数据和运行时的安全隔离边界。

核心字段：

| 字段 | 含义 |
|---|---|
| `tenant_id` | 不透明租户 ID |
| `tenant_mode` | `b2b` 或 `b2c` |
| `display_name` | 安全展示名称，不承担身份判断 |
| `status` | `provisioning`、`active`、`suspended`、`closing`、`closed` |
| `resource_version` | 单调增加的资源版本 |
| `created_at` / `updated_at` | UTC 时间 |

`closed` 是终态。Tenant 关闭不隐式定义数据删除策略，数据导出、保留和删除由
后续生命周期与合规服务显式处理。

### 4.2 Actor

Actor 表示被认证的人或内部服务，不包含认证提供商细节。

核心字段：

- `actor_id`；
- `actor_kind: human | service`；
- `status: active | disabled`；
- 可选安全展示信息；
- 资源版本和时间。

密码、OAuth Token、API Key 和设备密钥不进入 Actor Contract。

### 4.3 Membership

Membership 连接 Actor 和 Tenant，并表达该 Actor 在租户内的角色和席位状态。

核心字段：

- `membership_id`；
- `tenant_id`；
- `actor_id`；
- 非空、去重的 `roles[]`，v1 角色为 `admin`、`consultant`、`student`；
- 可选 `seat_ref`；
- `status: invited | active | suspended | revoked`；
- 资源版本和时间。

一个 Actor 可以加入多个 Tenant，但每次请求必须只选择一个有效 Membership。
`suspended` 或 `revoked` Membership 不能产生新的 TrustedRequestContext。

### 4.4 Profile

Profile 表示长期使用 Hermes 的操作者身份，而不是系统中出现的每个学生。

核心字段：

- `profile_id`；
- `tenant_id`；
- `owner_actor_id`；
- `profile_kind: default | consultant`；
- `status: provisioning | active | suspended | archived`；
- Hermes 运行时引用，不包含密钥；
- 资源版本和时间。

Profile 是配置、会话、Skill 和本地状态边界，不是操作系统级安全边界。跨租户
隔离由 RuntimeContainer 和持久化 Volume 承担。

### 4.5 B2B 与 B2C 不变量

B2B：

- Tenant 代表公司；
- 管理员和顾问都是 Membership；
- 拥有顾问角色的长期 Agent 操作者对应 Consultant Profile；
- 学生是业务对象，通过 StudentRef / CaseRef 访问，不创建学生 Profile；
- 一个公司 RuntimeContainer 可以容纳多个顾问 Profile。

B2C：

- Tenant 代表学生本人；
- 学生 Actor 拥有 Student Membership；
- Tenant 只有一个 Default Profile；
- 学生同时是租户、操作者和长期记忆主体；
- 不创建 Consultant Profile。

所有 Membership、Profile、Container 和 TrustedRequestContext 的 `tenant_id`
必须一致。管理员可以管理 Profile，但不能静默成为另一个顾问 Profile 的操作者；
代理访问必须使用显式 Delegation 并产生独立审计。

## 5. 外部业务引用

核心协议不复制领域业务事实，只定义稳定引用：

### 5.1 StudentRef

- `student_id`；
- `source_system`；
- 可选 `source_version`。

### 5.2 CaseRef

- `case_id`；
- `student_id`；
- `capability_id`；
- 可选 `source_system` 和 `source_version`。

存在 CaseRef 时必须同时存在匹配的 StudentRef。Case 所属关系必须由服务端
权威状态校验，不能仅相信引用中的字符串。

### 5.3 EntitlementSnapshotRef

- `snapshot_id`；
- `version`；
- `evaluated_at`。

该引用证明“使用了哪一版授权判断”，但不替代高风险执行前的最新授权检查。

### 5.4 ConsentSnapshotRef

为未来 B2C 学生向 B2B 顾问共享数据预留：

- `snapshot_id`；
- `version`；
- `evaluated_at`。

本阶段只定义引用，不定义 Consent Grant 的业务字段和存储。

## 6. 运行时与执行模型

### 6.1 RuntimeContainer

RuntimeContainer 唯一归属一个 Tenant。

核心字段：

- `container_id`、`tenant_id`；
- `runtime_kind: hermes`；
- `desired_state: running | stopped | deleted`；
- `observed_state`；
- 固定 digest 的 `image_ref`；
- `generation`；
- 不透明 `volume_ref`；
- 健康状态、最近探测时间和失败摘要；
- 资源版本和时间。

`observed_state` v1：

```text
requested → provisioning → starting → ready
ready ↔ draining / upgrading / recovering
ready → stopping → stopped → starting
任意非终态 → failed
deleting → deleted
```

客户端只能提交期望状态，不能直接声称 observed state。Container 删除和
Tenant Volume 删除是两个独立、显式操作。

### 6.2 Conversation

Conversation 是用户可见、可长期保存的对话线程。

- 固定 `tenant_id`、`profile_id` 和创建者 Actor；
- 可以不绑定业务对象，形成公司/个人通用对话；
- 可以在创建时绑定 StudentRef 和 CaseRef；
- 绑定 Case 后不得静默切换到另一个 Case，应创建新 Conversation；
- 容器重启、升级或 B2C 休眠不改变 Conversation ID；
- 状态为 `active | archived | closed`。

### 6.3 Session

Session 是可过期的运行连接和路由租约，不是长期对话本身。

- 绑定 Tenant、Profile、Actor 和 Conversation；
- 状态为 `active | idle | expired | closed`；
- 记录创建、最近活动和过期时间；
- 可以包含不透明的 Hermes runtime session ref；
- B2C 休眠可以终止 Session，但不得归档 Conversation。

### 6.4 AgentRun

AgentRun 表示一次用户消息触发的一轮中枢执行。

- `run_id`、`conversation_id`、`request_id`、`trace_id`；
- `client_request_id` 和 `idempotency_key`；
- 可选 `parent_run_id`；
- 状态为 `queued | running | waiting_approval | succeeded | failed | cancelled`；
- 包含开始、结束时间和安全失败摘要；
- 终态不可覆盖。

失败 Run 的重试必须创建新 Run，并通过 `parent_run_id` 指向原 Run。

### 6.5 Task

Task 表示可以跨 AgentRun 存续的业务动作。

- 唯一归属 Tenant，并关联发起 Run；
- 可选关联 Capability、Student 和 Case；
- 状态为 `queued | running | waiting_approval | paused | succeeded | failed | cancelled`；
- 包含幂等键、尝试次数、依赖状态和安全结果摘要；
- 具体业务输入输出留在领域 MCP Contract，不进入核心 Task。

### 6.6 Approval

Approval 是结构化暂停点，不依赖聊天文本约定。

- `approval_id`、`tenant_id`、`task_id`、`run_id`；
- 请求动作和经过脱敏的人类可读摘要；
- `status: pending | approved | rejected | expired | cancelled`；
- 请求者、决定者、时间、原因和 Trusted Context 版本；
- 可选过期时间。

Approval 通过后，真正执行前必须再次验证 Membership、Entitlement、Consent
和 Case 作用域。最终提交申请、付款、接受合同、签署文件和对外发送消息必须支持
该暂停模型。

## 7. TrustedRequestContext

### 7.1 定位

TrustedRequestContext 是 Control Plane 根据服务端事实签发的短期内部请求凭证。
它不是客户端 JSON、不是用户登录 Token，也不是 Agent 可以修改的 Prompt 内容。

客户端只能表达请求意图，例如期望的 Profile、Student 或 Case。Control Plane
必须重新解析：

1. 认证 Actor；
2. 获取有效 Membership 和角色；
3. 校验 Tenant、Profile、Student 与 Case；
4. 解析 Entitlement 与 Consent 版本；
5. 选择 Container；
6. 生成 Request、Trace、Conversation 和 Run 关联；
7. 签发只面向内部 audience 的短期 Context。

### 7.2 Payload 字段

身份：

- `tenant_mode`、`tenant_id`；
- `actor_id`、`membership_id`；
- 从 Membership roles 中选出的单个 `effective_role`；
- `profile_id`。

业务作用域：

- 可选 StudentRef、CaseRef；
- EntitlementSnapshotRef；
- 可选 ConsentSnapshotRef；
- 允许向 Agent 展示的 Capability ID 摘要。

执行关联：

- `container_id`；
- `conversation_id`、`run_id`；
- `request_id`、`trace_id`、`client_request_id`。

来源证明：

- `context_id`；
- `issuer`、`audience[]`；
- `issued_at`、`expires_at`；
- 签名 Envelope 的 `key_id`。

显式代理访问：

- 可选 `delegation_id` 和 `delegation_reason`；
- `original_actor_id` 始终保存真实认证 Actor；
- `target_profile_id` 记录目标 Profile。

### 7.3 安全规则

- Context 默认有效期不超过 5 分钟；
- 浏览器和普通客户端永远拿不到内部签名 Context；
- 内部消费者必须验证签名、issuer、audience、有效期和协议版本；
- 客户端或模型传入的 tenant、actor、role、entitlement 字段不能覆盖 Context；
- Agent 可以读取最小必要上下文，但不能写回或提升权限；
- Membership、Entitlement 或 Consent 撤销后，下一轮必须重新签发；
- 长任务执行前和高风险动作提交前必须查询最新权威状态；
- 签名失败、过期、audience 不符或作用域冲突一律 fail closed，并生成 AuditEvent；
- Context 不包含密码、API Key、完整学生档案或付款信息。

签名传输采用非对称签名和严格算法白名单。具体 JWS/Ed25519 封装、密钥轮换和
验证库由后续 Identity Runtime Spec 决定；v1 先冻结 Payload 和验证语义，避免把
密码学实现耦合进领域模型。

## 8. ProductEvent

ProductEvent 是 Web、Apple 和内部消费者共享的产品事件协议。

### 8.1 Envelope

所有事件包含：

- `schema_version`；
- `event_id`、`event_type`；
- `occurred_at`、流内 `sequence`；
- `tenant_id`；
- `request_id`、`trace_id`；
- `correlation_id`、`causation_id`；
- 类型化 `payload`。

按事件可选关联：

- `profile_id`、`conversation_id`、`run_id`；
- `task_id`、`approval_id`；
- StudentRef、CaseRef、`capability_id`。

### 8.2 v1 事件族

- `conversation.created`、`conversation.archived`；
- `run.queued`、`run.started`、`run.waiting_approval`、`run.completed`、
  `run.failed`、`run.cancelled`；
- `message.delta`、`message.completed`；
- `task.created`、`task.status_changed`；
- `approval.requested`、`approval.resolved`；
- `tool.requested`、`tool.started`、`tool.succeeded`、`tool.failed`；
- `runtime.status_changed`；
- `error.reported`。

Tool 事件属于核心事件语义，但本阶段不实现 MCP 调用。

### 8.3 交付语义

- 采用至少一次交付；消费者按 `event_id` 去重；
- 仅保证同一 Conversation / Run stream 内 sequence 有序，不承诺全局顺序；
- 客户端使用 cursor 断线恢复，不依赖连接永久在线；
- 未识别 event type 的消费者必须保留 cursor 并安全忽略，不能中断整个流；
- ProductEvent 不包含 API Key、完整敏感 Tool 参数或模型隐藏推理；
- 同一状态变化可以生成 ProductEvent 与 AuditEvent，但两者 ID 独立。

## 9. AuditEvent

AuditEvent 是服务端生成、只追加、不可由客户端或 Agent 提供的合规记录。

核心字段：

- `audit_event_id`、`schema_version`、`occurred_at`；
- `tenant_id`；
- 真实 `actor_id`、`membership_id`、`effective_role`；
- 可选 Delegation；
- `action`、资源类型和资源 ID；
- `decision: allowed | denied | not_applicable`；
- `outcome: succeeded | failed | cancelled | pending`；
- 策略、Entitlement 和 Consent 版本引用；
- `request_id`、`trace_id`、`run_id`、`task_id`、`approval_id`；
- 经过脱敏的原因和变更摘要。

AuditEvent 不是客户端聊天事件，不记录密钥、隐藏推理或不必要的敏感 Payload。
审计存储、保留期限和法定导出由后续 Audit Runtime 设计，但 Contract 从 v1 起稳定。

## 10. ErrorEnvelope

ErrorEnvelope 提供稳定机器语义和安全人类信息：

- `schema_version`、`error_id`；
- 稳定 `code`；
- `category`；
- 安全 `message`；
- `retryable` 和可选 `retry_after_ms`；
- 可选、经过白名单的字段错误 details；
- `request_id`、`trace_id`；
- 可选资源和状态引用。

v1 Category：

- `validation`；
- `authentication`；
- `authorization`；
- `conflict`；
- `rate_limit`；
- `dependency`；
- `unavailable`；
- `timeout`；
- `internal`。

首批稳定 Error Code：

- `TENANT_SCOPE_MISMATCH`；
- `PROFILE_NOT_ACTIVE`；
- `CONTEXT_EXPIRED`；
- `ENTITLEMENT_DENIED`；
- `APPROVAL_REQUIRED`；
- `IDEMPOTENCY_CONFLICT`；
- `DEPENDENCY_UNAVAILABLE`；
- `INTERNAL_ERROR`。

HTTP 状态码只是传输映射，稳定 Error Code 才是业务语义。内部堆栈、供应商原始
错误和敏感原因只进入受控日志或脱敏审计。

## 11. 幂等、重试和并发

- 所有产生副作用的写请求必须提供 `idempotency_key` 和规范化 Payload Hash；
- 同 Key、同 Payload 返回原结果；
- 同 Key、不同 Payload 返回 `IDEMPOTENCY_CONFLICT`；
- 失败 AgentRun 重试创建新 Run，通过 `parent_run_id` 关联；
- ProductEvent 至少一次交付，消费者去重；
- 资源写入携带预期 `resource_version`，版本不符返回 Conflict；
- 外部依赖重试不得重复付款、提交申请、签署文件或对外发送消息；
- Approval 恢复和长任务恢复必须重新验证当前授权状态。

## 12. 版本与兼容

协议包使用 SemVer，Wire Schema 使用整数版本。

- Patch：不改变 Wire Format 的文档、错误文本或测试修正；
- Minor：v1 内增加真正可选字段、增加消费者可安全忽略的事件类型或错误码；
- Major：删除字段、改变字段含义、改变必填规则、收窄类型、改变状态机语义，或
  使旧消费者无法安全忽略的新枚举行为。

安全关键类型使用严格生产者验证和明确版本匹配。ProductEvent 消费者必须具有
Unknown Event fallback，以支持 v1 内新增事件类型。任何协议变更都必须附兼容性
说明、Schema Diff 和 fixtures 更新。

## 13. 测试与发布门禁

### 13.1 Schema 测试

- 每个 Schema 至少一个合法 fixture；
- 每条关键约束至少一个非法 fixture；
- TypeScript 类型与运行时 Schema 一致；
- JSON Schema 重新生成后 Git 无差异；
- 所有示例通过真实运行时验证器。

### 13.2 不变量测试

- 跨 Tenant 的 Membership / Profile / Container / Context 必须拒绝；
- CaseRef 与 StudentRef 不匹配必须拒绝；
- suspended/revoked Membership 不可签发 Context；
- B2B/B2C Profile 组合违反模式规则时拒绝；
- Context 过期、错误 audience、伪造角色和作用域冲突必须拒绝；
- 管理员代理访问缺少 Delegation 时拒绝。

### 13.3 状态机测试

每个状态机维护允许/禁止转换矩阵，覆盖 Container、Tenant、Membership、Profile、
Session、AgentRun、Task 和 Approval。客户端提交 observed state 或跳过必要中间状态
必须拒绝。

### 13.4 交付与幂等测试

- 乱序 Event；
- 重复 Event；
- cursor 断线恢复；
- 同幂等键同 Payload；
- 同幂等键不同 Payload；
- 失败 Run 创建新 Run；
- Approval 前后授权版本变化。

### 13.5 安全与数据卫生

- fixtures 不含真实 API Key、客户、公司或学生数据；
- Schema 错误不回显密钥或完整敏感 Payload；
- ProductEvent 不允许隐藏推理字段；
- Contract 测试不依赖 Docker、数据库或网络；
- CI 检测明显 Secret Pattern 和生成产物漂移。

### 13.6 兼容性门禁

- 保存 v1 Schema 快照；
- 自动检测字段删除、类型变化、必填变化和枚举收窄；
- 每次变更明确声明 Patch / Minor / Major；
- 破坏性变化必须创建新 Wire Version，不能覆盖 v1。

## 14. MCP 后续接入方案

本阶段只记录边界，不实现 MCP。

- 新建第一方 MCP Server 默认 TypeScript；
- MCP Gateway 和 TypeScript MCP Server 可以直接依赖 `@core-agent/contracts`；
- 已有 Python 服务读取生成的 JSON Schema，保留原业务实现；
- 核心包只共享 Tenant、Profile、Trusted Context、Error、Event 和引用类型；
- 具体工具输入输出由领域服务维护，例如 `eduapply.get_case` 不进入核心包；
- MCP Gateway 必须验证签名 Context，并忽略模型自行提交的 Tenant、Actor、Role、
  Entitlement 和 Consent；
- 写工具必须具有幂等键、结构化结果、审计事件和 Human Approval 语义；
- MCP 服务独立版本化，一个业务能力升级不要求发布整个 Core-Agent；
- 本阶段不加入 MCP SDK、不创建空 Server、不提交虚假 Tool 占位。

未来 MCP 完整执行链：

```text
Agent
→ MCP Gateway
→ 校验 TrustedRequestContext
→ 重新验证 Entitlement / Role / Case / Consent
→ Domain MCP Service
→ 结构化结果
→ ProductEvent + AuditEvent
→ 可选 Memory Candidate
```

## 15. 安全和隐私不变量

1. Tenant 是最终数据和容器隔离边界；
2. Profile 不是安全沙箱；
3. 客户端和 Agent 不能产生可信身份或提升权限；
4. 所有内部授权消费者只相信有效的 TrustedRequestContext；
5. 撤权后下一轮生效，高风险动作执行前再次验证；
6. 浏览器不持有 Hermes API Key 或内部 Context；
7. ProductEvent、AuditEvent 和 ErrorEnvelope 默认最小披露；
8. 最终提交、付款、签署和对外消息必须支持 Human Approval；
9. Container 删除和 Volume 删除必须分离；
10. 所有写操作可审计、可去重、可重试且不重复产生外部副作用。

## 16. 验收标准

本阶段完成时必须满足：

1. `@core-agent/contracts` 可独立构建和测试；
2. 所有已定义资源均有 TypeScript 类型、运行时 Schema 和 v1 JSON Schema；
3. 合法 fixtures 全部通过，非法 fixtures 按稳定错误原因失败；
4. B2B/B2C、跨租户、状态机、Context、Event 和幂等不变量有测试；
5. 生成产物和兼容性快照受 CI 保护；
6. 核心包不依赖 Docker、数据库、Hermes 或 MCP SDK；
7. 不包含真实密钥、客户数据、学生数据或业务服务代码；
8. README 说明如何供 TypeScript、JSON Schema、未来 OpenAPI/Python 使用；
9. 后续 Control Plane Runtime 和 Web 可以引用该包而不重新定义协议；
10. MCP 只保留本规格中的后续接入边界，无空实现。

## 17. 明确延后到后续 Spec 的决定

以下内容不是本设计的缺口，而是有意由对应运行子系统决定：

- Trusted Context 的具体 JWS/Ed25519 库、密钥轮换和吊销实现；
- 数据库表、索引、事务和事件存储；
- 登录供应商、Session Cookie 和设备认证；
- Event Broker、SSE/WebSocket 和持久化 Cursor 实现；
- Docker/Kubernetes 容器控制器；
- Entitlement SKU、价格、席位和购买冲突规则；
- MCP SDK 版本和第一个业务 Tool Schema；
- OpenAPI 服务路由和 Swift 代码生成工具；
- Audit 数据保留期和合规导出格式。

这些后续实现必须服从本规格已经冻结的资源身份、状态、上下文、事件、错误、
幂等和安全不变量。
