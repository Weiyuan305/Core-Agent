# Control Plane Contracts v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可独立构建、运行时校验并生成标准 JSON Schema 的 `@core-agent/contracts` v1，使 Control Plane、Hermes 平台扩展、未来 TypeScript MCP、Python 领域服务、Web 和 Apple 客户端共享同一套身份、运行时、可信上下文、事件、审计、错误与幂等协议。

**Architecture:** TypeBox 1.x 源码是唯一作者源，TypeScript 静态类型、Node 运行时验证器和提交到 Git 的 JSON Schema 都由它产生。跨对象与状态机规则由无 I/O 的纯函数实现。包不连接 Docker、数据库、网络、Hermes 或 MCP SDK；根工作区只负责统一脚本和 CI。生成 Schema、兼容基线和匿名 fixtures 均纳入版本控制。

**Tech Stack:** Node.js 22+ ESM、npm workspaces、TypeScript `7.0.2`、TypeBox `1.3.10`、tsx `4.23.5`、Node 内置 `node:test`、GitHub Actions。

## Global Constraints

- 严格遵循已批准的设计规格：`docs/superpowers/specs/2026-08-03-control-plane-contracts-v1-design.md`。
- Wire JSON 字段只使用 `snake_case`；协议对象带 `schema_version: 1`，资源带正整数 `resource_version`。
- 时间只接受 UTC、带 `Z` 的 RFC 3339 字符串；ID 是不可解析的不透明字符串。
- TypeBox 源文件是唯一作者源；不得手工编辑 `schemas/v1/*.schema.json` 或 `compat/v1/*.schema.json`。
- `TrustedRequestContext` 只冻结 payload、签名 envelope 和验证语义，不实现 JWS、Ed25519、密钥轮换或签名验证库。
- MCP 只保留 README 中的后续接入边界；本计划不安装 MCP SDK、不创建 MCP Server、不创建空 Tool。
- 所有校验器必须是确定性的纯函数；测试不得依赖 Docker、数据库、网络、当前系统时间或真实客户数据。
- fixtures 只使用 `tenant_demo`、`actor_demo`、`student_demo` 等合成值，不包含 API Key、Token、公司名、顾问名或学生真实资料。
- 每个任务都执行红灯测试、最小实现、绿灯测试、差异检查和独立提交；Reviewer Gate 通过前不进入下一任务。
- 若实现与规格冲突，先停止并修改规格/计划，经审阅后再继续，不在代码中暗自改变协议语义。

---

## 目标目录结构

```text
Core-Agent/
├── .github/workflows/runtime-contract.yml
├── package.json
├── package-lock.json
├── packages/contracts/
│   ├── README.md
│   ├── package.json
│   ├── tsconfig.json
│   ├── compat/v1/
│   ├── fixtures/v1/
│   │   ├── invalid/
│   │   └── valid/
│   ├── schemas/v1/
│   ├── scripts/
│   │   ├── check-compatibility.ts
│   │   ├── generate-schemas.ts
│   │   └── verify-fixtures.ts
│   ├── src/
│   │   ├── approval/schema.ts
│   │   ├── audit/audit-event.ts
│   │   ├── common/primitives.ts
│   │   ├── common/validation.ts
│   │   ├── errors/error-envelope.ts
│   │   ├── events/product-event.ts
│   │   ├── profile/profile.ts
│   │   ├── request-context/trusted-request-context.ts
│   │   ├── runtime/delivery.ts
│   │   ├── runtime/idempotency.ts
│   │   ├── runtime/invariants.ts
│   │   ├── runtime/refs.ts
│   │   ├── runtime/resources.ts
│   │   ├── runtime/transitions.ts
│   │   ├── tenant/identity.ts
│   │   ├── index.ts
│   │   └── registry.ts
│   └── tests/
│       ├── compatibility.test.ts
│       ├── delivery.test.ts
│       ├── fixtures.test.ts
│       ├── identity.test.ts
│       ├── primitives.test.ts
│       ├── product-event.test.ts
│       ├── runtime.test.ts
│       ├── schema-generation.test.ts
│       ├── security.test.ts
│       └── trusted-request-context.test.ts
└── docs/superpowers/specs/2026-08-03-control-plane-contracts-v1-design.md
```

---

### Task 1: 建立 npm workspace、TypeScript 包和测试闭环

**Interfaces:**

- Consumes: 根 `package.json` 的现有 Hermes 脚本、Node.js `>=22` 约束。
- Produces: 可解析的 `@core-agent/contracts` workspace、严格 TypeScript 编译、根级 `contracts:*` 命令。
- Does not produce: 任何协议资源 Schema；本任务只建立执行闭环。

**Files:**

- Modify: `package.json`
- Create: `package-lock.json`（仅由 `npm install --package-lock-only` 生成）
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/tests/package.test.ts`

#### Step 1: 写一个会失败的包入口测试

- [ ] 创建 `packages/contracts/tests/package.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_PACKAGE_VERSION, WIRE_SCHEMA_VERSION } from "../src/index.js";

test("exports the package and wire versions", () => {
  assert.equal(CONTRACT_PACKAGE_VERSION, "0.1.0");
  assert.equal(WIRE_SCHEMA_VERSION, 1);
});
```

- [ ] 运行：

```bash
cd /Users/weiyuan/personal/Core-Agent
node --import tsx --test packages/contracts/tests/package.test.ts
```

Expected: 失败，错误包含 `ERR_MODULE_NOT_FOUND`，因为 workspace 依赖和入口尚未建立。

#### Step 2: 配置根 workspace 与固定依赖

- [ ] 将根 `package.json` 改为：

```json
{
  "name": "@core-agent/platform",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "test": "node --test && npm run test -w @core-agent/contracts",
    "contracts:build": "npm run build -w @core-agent/contracts",
    "contracts:test": "npm run test -w @core-agent/contracts",
    "contracts:schemas": "npm run schemas -w @core-agent/contracts",
    "contracts:check": "npm run check -w @core-agent/contracts",
    "hermes:image-ref": "node scripts/resolve-hermes-image.mjs",
    "hermes:build": "node scripts/build-hermes-image.mjs",
    "hermes:bootstrap": "node scripts/bootstrap-demo-company.mjs",
    "hermes:smoke": "node scripts/smoke-runtime.mjs"
  },
  "devDependencies": {
    "tsx": "4.23.5",
    "typescript": "7.0.2"
  }
}
```

- [ ] 创建 `packages/contracts/package.json`：

```json
{
  "name": "@core-agent/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./schemas/v1/*": "./schemas/v1/*"
  },
  "files": [
    "dist",
    "schemas",
    "README.md"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "node --import tsx --test tests/*.test.ts",
    "schemas": "tsx scripts/generate-schemas.ts",
    "schemas:check": "tsx scripts/generate-schemas.ts --check",
    "fixtures:check": "tsx scripts/verify-fixtures.ts",
    "compat:check": "tsx scripts/check-compatibility.ts",
    "check": "npm run build && npm test && npm run schemas:check && npm run fixtures:check && npm run compat:check"
  },
  "dependencies": {
    "typebox": "1.3.10"
  }
}
```

- [ ] 创建 `packages/contracts/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noEmitOnError": true,
    "skipLibCheck": false
  },
  "include": [
    "src/**/*.ts"
  ]
}
```

- [ ] 生成 lockfile，不能手写：

```bash
cd /Users/weiyuan/personal/Core-Agent
npm install --package-lock-only
npm ci
```

Expected: `npm ci` 退出码为 0，安装的 `typebox`、`typescript`、`tsx` 版本与上述固定版本一致。

#### Step 3: 添加最小入口使测试转绿

- [ ] 创建 `packages/contracts/src/index.ts`：

```ts
export const CONTRACT_PACKAGE_VERSION = "0.1.0" as const;
export const WIRE_SCHEMA_VERSION = 1 as const;
```

- [ ] 运行：

```bash
npm run contracts:test
npm run contracts:build
npm test
```

Expected: 三条命令均退出码 0；现有 Hermes runtime tests 仍然通过。

#### Step 4: 检查并提交

- [ ] 运行：

```bash
git diff --check
git status --short
```

Expected: 无 whitespace error；只出现本任务列出的文件和 `node_modules/` 的忽略状态。

- [ ] 提交：

```bash
git add package.json package-lock.json packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/src/index.ts packages/contracts/tests/package.test.ts
git commit -m "build: scaffold contracts workspace"
```

**Reviewer Gate:** 审阅者确认版本全部固定、根 Hermes 脚本未丢失、包能独立测试和编译、没有引入 Docker/数据库/MCP 依赖。

---

### Task 2: 实现通用原语与外部业务引用

**Interfaces:**

- Consumes: TypeBox、`WIRE_SCHEMA_VERSION`。
- Produces: 所有后续资源共享的 ID、时间、元数据、分页、Trace、幂等字段与 `StudentRef` / `CaseRef` / SnapshotRef。
- Invariants: UTC `Z` 时间、正整数版本、非空 opaque ID、Case 与 Student 作用域一致。

**Files:**

- Create: `packages/contracts/src/common/primitives.ts`
- Create: `packages/contracts/src/common/validation.ts`
- Create: `packages/contracts/src/runtime/refs.ts`
- Create: `packages/contracts/tests/primitives.test.ts`
- Modify: `packages/contracts/src/index.ts`

#### Step 1: 写原语和引用的红灯测试

- [ ] 创建 `packages/contracts/tests/primitives.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  CaseRefSchema,
  ResourceMetadataSchema,
  StudentRefSchema,
  validateCaseScope,
} from "../src/index.js";

const metadata = {
  schema_version: 1,
  resource_version: 1,
  created_at: "2026-08-03T01:02:03Z",
  updated_at: "2026-08-03T01:02:03Z",
};

test("resource metadata accepts UTC Z timestamps", () => {
  assert.equal(Schema.Compile(ResourceMetadataSchema).Check(metadata), true);
});

test("resource metadata rejects offsets and zero resource versions", () => {
  assert.equal(
    Schema.Compile(ResourceMetadataSchema).Check({
      ...metadata,
      resource_version: 0,
      updated_at: "2026-08-03T09:02:03+08:00",
    }),
    false,
  );
});

test("opaque references reject empty identifiers", () => {
  assert.equal(
    Schema.Compile(StudentRefSchema).Check({
      student_id: "",
      source_system: "eduapply",
    }),
    false,
  );
  assert.equal(
    Schema.Compile(CaseRefSchema).Check({
      case_id: "case_demo",
      student_id: "student_demo",
      capability_id: "",
    }),
    false,
  );
});

test("case scope must reference the selected student", () => {
  assert.deepEqual(
    validateCaseScope(
      { student_id: "student_demo", source_system: "eduapply" },
      {
        case_id: "case_demo",
        student_id: "student_other",
        capability_id: "eduapply.application",
      },
    ).map((item) => item.code),
    ["CASE_STUDENT_MISMATCH"],
  );
});
```

- [ ] 运行：

```bash
node --import tsx --test --test-name-pattern="resource metadata|opaque references|case scope" packages/contracts/tests/*.test.ts
```

Expected: 失败，错误指向尚未导出的 Schema 和 `validateCaseScope`。

#### Step 2: 实现通用 Schema 与稳定违规结构

- [ ] 创建 `packages/contracts/src/common/primitives.ts`：

```ts
import Type, { type Static } from "typebox";

export const SchemaVersionSchema = Type.Literal(1, {
  title: "SchemaVersion",
});

export const OpaqueIdSchema = Type.String({ minLength: 1, maxLength: 255 });
export const UtcTimestampSchema = Type.String({
  format: "date-time",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$",
});
export const ResourceVersionSchema = Type.Integer({ minimum: 1 });
export const SequenceSchema = Type.Integer({ minimum: 0 });

export const ResourceMetadataFields = {
  schema_version: SchemaVersionSchema,
  resource_version: ResourceVersionSchema,
  created_at: UtcTimestampSchema,
  updated_at: UtcTimestampSchema,
} as const;

export const ResourceMetadataSchema = Type.Object(
  ResourceMetadataFields,
  { additionalProperties: false, $id: "core-agent://v1/resource-metadata" },
);

export const TraceContextSchema = Type.Object(
  {
    request_id: OpaqueIdSchema,
    trace_id: OpaqueIdSchema,
    client_request_id: OpaqueIdSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/trace-context" },
);

export const PageRequestSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    cursor: Type.Optional(OpaqueIdSchema),
    limit: Type.Integer({ minimum: 1, maximum: 200 }),
  },
  { additionalProperties: false, $id: "core-agent://v1/page-request" },
);

export const PageInfoSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    next_cursor: Type.Optional(OpaqueIdSchema),
    has_more: Type.Boolean(),
  },
  { additionalProperties: false, $id: "core-agent://v1/page-info" },
);

export type ResourceMetadata = Static<typeof ResourceMetadataSchema>;
export type TraceContext = Static<typeof TraceContextSchema>;
export type PageRequest = Static<typeof PageRequestSchema>;
export type PageInfo = Static<typeof PageInfoSchema>;
```

- [ ] 创建 `packages/contracts/src/common/validation.ts`：

```ts
export interface ContractViolation {
  code: string;
  path: string;
  message: string;
}

export function violation(
  code: string,
  path: string,
  message: string,
): ContractViolation {
  return { code, path, message };
}
```

#### Step 3: 实现外部引用与跨引用校验

- [ ] 创建 `packages/contracts/src/runtime/refs.ts`：

```ts
import Type, { type Static } from "typebox";

import { OpaqueIdSchema, UtcTimestampSchema } from "../common/primitives.js";
import { type ContractViolation, violation } from "../common/validation.js";

export const StudentRefSchema = Type.Object(
  {
    student_id: OpaqueIdSchema,
    source_system: OpaqueIdSchema,
    source_version: Type.Optional(OpaqueIdSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/student-ref" },
);

export const CaseRefSchema = Type.Object(
  {
    case_id: OpaqueIdSchema,
    student_id: OpaqueIdSchema,
    capability_id: OpaqueIdSchema,
    source_system: Type.Optional(OpaqueIdSchema),
    source_version: Type.Optional(OpaqueIdSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/case-ref" },
);

const SnapshotFields = {
  snapshot_id: OpaqueIdSchema,
  version: Type.Integer({ minimum: 1 }),
  evaluated_at: UtcTimestampSchema,
};

export const EntitlementSnapshotRefSchema = Type.Object(SnapshotFields, {
  additionalProperties: false,
  $id: "core-agent://v1/entitlement-snapshot-ref",
});

export const ConsentSnapshotRefSchema = Type.Object(SnapshotFields, {
  additionalProperties: false,
  $id: "core-agent://v1/consent-snapshot-ref",
});

export type StudentRef = Static<typeof StudentRefSchema>;
export type CaseRef = Static<typeof CaseRefSchema>;
export type EntitlementSnapshotRef = Static<typeof EntitlementSnapshotRefSchema>;
export type ConsentSnapshotRef = Static<typeof ConsentSnapshotRefSchema>;

export function validateCaseScope(
  student: StudentRef | undefined,
  caseRef: CaseRef | undefined,
): ContractViolation[] {
  if (caseRef === undefined) return [];
  if (student === undefined) {
    return [violation("CASE_REQUIRES_STUDENT", "case_ref.student_id", "Case scope requires a student reference")];
  }
  return caseRef.student_id === student.student_id
    ? []
    : [violation("CASE_STUDENT_MISMATCH", "case_ref.student_id", "Case and student scope do not match")];
}
```

- [ ] 在 `packages/contracts/src/index.ts` 追加：

```ts
export * from "./common/primitives.js";
export * from "./common/validation.js";
export * from "./runtime/refs.js";
```

#### Step 4: 验证、检查并提交

- [ ] 运行：

```bash
npm run contracts:test
npm run contracts:build
git diff --check
```

Expected: 全部退出码 0；生成的 `.d.ts` 中 `StudentRef`、`CaseRef` 和 SnapshotRef 与 Schema 字段一致。

- [ ] 提交：

```bash
git add packages/contracts/src packages/contracts/tests/primitives.test.ts
git commit -m "feat(contracts): add common primitives and domain refs"
```

**Reviewer Gate:** 审阅者确认 wire 字段为 `snake_case`、时间 pattern 只接受 UTC `Z`、所有对象拒绝多余字段、Case/Student 不变量返回稳定 code。

---

### Task 3: 实现 Tenant、Actor、Membership、Profile 与 B2B/B2C 不变量

**Interfaces:**

- Consumes: 通用原语、`ContractViolation`。
- Produces: `TenantSchema`、`ActorSchema`、`MembershipSchema`、`ProfileSchema`、`IdentityGraphSchema`、`validateIdentityGraph`。
- Invariants: 全部资源同租户；Membership 角色非空且去重；B2B consultant Profile 归属 active consultant；B2C 仅一个 default Profile；不可借 admin 身份静默操作其他 Profile。

**Files:**

- Create: `packages/contracts/src/tenant/identity.ts`
- Create: `packages/contracts/src/profile/profile.ts`
- Create: `packages/contracts/tests/identity.test.ts`
- Modify: `packages/contracts/src/index.ts`

#### Step 1: 写身份图红灯测试

- [ ] 创建 `packages/contracts/tests/identity.test.ts`，使用下面的完整基线对象并覆盖关键失败：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  IdentityGraphSchema,
  MembershipSchema,
  validateIdentityGraph,
  type IdentityGraph,
} from "../src/index.js";

const timestamp = "2026-08-03T01:02:03Z";
const resource = { schema_version: 1 as const, resource_version: 1, created_at: timestamp, updated_at: timestamp };

const b2bGraph: IdentityGraph = {
  schema_version: 1,
  tenant: { ...resource, tenant_id: "tenant_demo", tenant_mode: "b2b", display_name: "Demo tenant", status: "active" },
  actors: [
    { ...resource, actor_id: "actor_consultant", actor_kind: "human", status: "active", display_name: "Consultant" },
  ],
  memberships: [
    { ...resource, membership_id: "membership_demo", tenant_id: "tenant_demo", actor_id: "actor_consultant", roles: ["consultant"], status: "active" },
  ],
  profiles: [
    { ...resource, profile_id: "profile_demo", tenant_id: "tenant_demo", owner_actor_id: "actor_consultant", profile_kind: "consultant", status: "active", hermes_profile_ref: "hermes_profile_demo" },
  ],
};

test("validates a B2B consultant graph", () => {
  assert.equal(Schema.Compile(IdentityGraphSchema).Check(b2bGraph), true);
  assert.deepEqual(validateIdentityGraph(b2bGraph), []);
});

test("membership roles are non-empty and unique", () => {
  assert.equal(Schema.Compile(MembershipSchema).Check({ ...b2bGraph.memberships[0], roles: [] }), false);
  assert.equal(Schema.Compile(MembershipSchema).Check({ ...b2bGraph.memberships[0], roles: ["consultant", "consultant"] }), false);
});

test("rejects a cross-tenant profile", () => {
  const graph = structuredClone(b2bGraph);
  graph.profiles[0]!.tenant_id = "tenant_other";
  assert.deepEqual(validateIdentityGraph(graph).map((item) => item.code), ["TENANT_SCOPE_MISMATCH"]);
});

test("rejects B2C consultant profiles and multiple defaults", () => {
  const graph = structuredClone(b2bGraph);
  graph.tenant.tenant_mode = "b2c";
  graph.memberships[0]!.roles = ["student"];
  graph.profiles.push({ ...graph.profiles[0]!, profile_id: "profile_second", profile_kind: "default" });
  assert.deepEqual(
    validateIdentityGraph(graph).map((item) => item.code).sort(),
    ["B2C_PROFILE_COUNT_INVALID", "B2C_PROFILE_KIND_INVALID"],
  );
});

test("rejects a consultant profile without an active consultant membership", () => {
  const graph = structuredClone(b2bGraph);
  graph.memberships[0]!.status = "suspended";
  assert.deepEqual(validateIdentityGraph(graph).map((item) => item.code), ["PROFILE_OWNER_NOT_ACTIVE_CONSULTANT"]);
});
```

- [ ] 运行：

```bash
node --import tsx --test --test-name-pattern="B2B|membership roles|cross-tenant|B2C|consultant profile" packages/contracts/tests/*.test.ts
```

Expected: 失败，因为身份资源尚未实现。

#### Step 2: 实现身份资源 Schema

- [ ] 创建 `packages/contracts/src/tenant/identity.ts`，定义并导出：

```ts
import Type, { type Static } from "typebox";

import { OpaqueIdSchema, ResourceMetadataFields } from "../common/primitives.js";

export const TenantModeSchema = Type.Union([Type.Literal("b2b"), Type.Literal("b2c")]);
export const TenantStatusSchema = Type.Union([
  Type.Literal("provisioning"), Type.Literal("active"), Type.Literal("suspended"),
  Type.Literal("closing"), Type.Literal("closed"),
]);
export const ActorKindSchema = Type.Union([Type.Literal("human"), Type.Literal("service")]);
export const ActorStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("disabled")]);
export const MembershipRoleSchema = Type.Union([
  Type.Literal("admin"), Type.Literal("consultant"), Type.Literal("student"),
]);
export const MembershipStatusSchema = Type.Union([
  Type.Literal("invited"), Type.Literal("active"), Type.Literal("suspended"), Type.Literal("revoked"),
]);

export const TenantSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    tenant_id: OpaqueIdSchema,
    tenant_mode: TenantModeSchema,
    display_name: Type.String({ minLength: 1, maxLength: 200 }),
    status: TenantStatusSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/tenant" },
);

export const ActorSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    actor_id: OpaqueIdSchema,
    actor_kind: ActorKindSchema,
    status: ActorStatusSchema,
    display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false, $id: "core-agent://v1/actor" },
);

export const MembershipSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    membership_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    roles: Type.Array(MembershipRoleSchema, { minItems: 1, uniqueItems: true }),
    seat_ref: Type.Optional(OpaqueIdSchema),
    status: MembershipStatusSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/membership" },
);

export type Tenant = Static<typeof TenantSchema>;
export type Actor = Static<typeof ActorSchema>;
export type Membership = Static<typeof MembershipSchema>;
```

- [ ] 创建 `packages/contracts/src/profile/profile.ts`，定义并导出：

```ts
import Type, { type Static } from "typebox";

import { OpaqueIdSchema, ResourceMetadataFields, SchemaVersionSchema } from "../common/primitives.js";
import { ActorSchema, MembershipSchema, TenantSchema } from "../tenant/identity.js";
import { type ContractViolation, violation } from "../common/validation.js";

export const ProfileKindSchema = Type.Union([Type.Literal("default"), Type.Literal("consultant")]);
export const ProfileStatusSchema = Type.Union([
  Type.Literal("provisioning"), Type.Literal("active"), Type.Literal("suspended"), Type.Literal("archived"),
]);

export const ProfileSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    profile_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    owner_actor_id: OpaqueIdSchema,
    profile_kind: ProfileKindSchema,
    status: ProfileStatusSchema,
    hermes_profile_ref: OpaqueIdSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/profile" },
);

export const IdentityGraphSchema = Type.Object({
  schema_version: SchemaVersionSchema,
  tenant: TenantSchema,
  actors: Type.Array(ActorSchema),
  memberships: Type.Array(MembershipSchema),
  profiles: Type.Array(ProfileSchema),
}, { additionalProperties: false, $id: "core-agent://v1/identity-graph" });

export type Profile = Static<typeof ProfileSchema>;
export type IdentityGraph = Static<typeof IdentityGraphSchema>;

export function validateIdentityGraph(graph: IdentityGraph): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const actorIds = new Set(graph.actors.map((actor) => actor.actor_id));
  const tenantMemberships = graph.memberships.filter((membership) => membership.tenant_id === graph.tenant.tenant_id);

  for (const membership of graph.memberships) {
    if (membership.tenant_id !== graph.tenant.tenant_id) violations.push(violation("TENANT_SCOPE_MISMATCH", "memberships.tenant_id", "Membership is outside the selected tenant"));
    if (!actorIds.has(membership.actor_id)) violations.push(violation("MEMBERSHIP_ACTOR_NOT_FOUND", "memberships.actor_id", "Membership actor does not exist"));
  }

  for (const profile of graph.profiles) {
    if (profile.tenant_id !== graph.tenant.tenant_id) {
      violations.push(violation("TENANT_SCOPE_MISMATCH", "profiles.tenant_id", "Profile is outside the selected tenant"));
      continue;
    }
    if (!actorIds.has(profile.owner_actor_id)) violations.push(violation("PROFILE_OWNER_NOT_FOUND", "profiles.owner_actor_id", "Profile owner does not exist"));
    if (graph.tenant.tenant_mode === "b2b" && profile.profile_kind === "consultant") {
      const membership = tenantMemberships.find((item) => item.actor_id === profile.owner_actor_id && item.status === "active" && item.roles.includes("consultant"));
      if (membership === undefined) violations.push(violation("PROFILE_OWNER_NOT_ACTIVE_CONSULTANT", "profiles.owner_actor_id", "Consultant profile requires an active consultant membership"));
    }
  }

  if (graph.tenant.tenant_mode === "b2c") {
    if (graph.profiles.length !== 1) violations.push(violation("B2C_PROFILE_COUNT_INVALID", "profiles", "B2C tenant requires exactly one profile"));
    if (graph.profiles.some((profile) => profile.profile_kind !== "default")) violations.push(violation("B2C_PROFILE_KIND_INVALID", "profiles.profile_kind", "B2C tenant only allows the default profile"));
  }
  return violations;
}
```

#### Step 3: 导出、绿灯与提交

- [ ] 在 `packages/contracts/src/index.ts` 追加：

```ts
export * from "./tenant/identity.js";
export * from "./profile/profile.js";
```

- [ ] 运行：

```bash
npm run contracts:test
npm run contracts:build
git diff --check
```

Expected: 身份测试全部通过；TypeScript strict build 退出码 0。

- [ ] 提交：

```bash
git add packages/contracts/src packages/contracts/tests/identity.test.ts
git commit -m "feat(contracts): define tenant identity and profiles"
```

**Reviewer Gate:** 审阅者确认 B2B 学生没有被建模成 Profile、B2C 只有一个 default Profile、跨租户引用 fail closed、Membership suspension 会使 consultant Profile 失去有效操作者关系。

---

### Task 4: 实现运行资源、Approval、状态机与跨资源不变量

**Interfaces:**

- Consumes: Tenant/Profile/Actor IDs、外部引用、Trace 原语。
- Produces: Container、Conversation、Session、AgentRun、Task、Approval Schema；八类状态转换函数；`validateRuntimeGraph`。
- Invariants: observed state 只能由平台报告；Conversation 的 Case 不可静默切换；Session 不等于 Conversation；失败重试创建新 Run；终态不可覆盖；Container 删除不代表 Volume 删除。

**Files:**

- Create: `packages/contracts/src/approval/schema.ts`
- Create: `packages/contracts/src/runtime/resources.ts`
- Create: `packages/contracts/src/runtime/transitions.ts`
- Create: `packages/contracts/src/runtime/invariants.ts`
- Create: `packages/contracts/tests/runtime.test.ts`
- Modify: `packages/contracts/src/index.ts`

#### Step 1: 写状态机与运行图红灯测试

- [ ] 创建 `packages/contracts/tests/runtime.test.ts`，完整包含下面这些断言：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  canTransitionAgentRun,
  canTransitionApproval,
  canTransitionContainerObservedState,
  canTransitionMembership,
  canTransitionProfile,
  canTransitionSession,
  canTransitionTask,
  canTransitionTenant,
  resolveContainerDeletion,
  RuntimeContainerSchema,
  validateContainerMutation,
  validateConversationScopeChange,
  validateRetryRun,
} from "../src/index.js";

test("container transitions require lifecycle intermediates", () => {
  assert.equal(canTransitionContainerObservedState("requested", "provisioning"), true);
  assert.equal(canTransitionContainerObservedState("requested", "ready"), false);
  assert.equal(canTransitionContainerObservedState("deleted", "starting"), false);
});

test("runtime container image references are immutable digests", () => {
  const base = {
    schema_version: 1, resource_version: 1, created_at: "2026-08-03T01:02:03Z", updated_at: "2026-08-03T01:02:03Z",
    container_id: "container_demo", tenant_id: "tenant_demo", runtime_kind: "hermes",
    desired_state: "running", observed_state: "ready", generation: 1, volume_ref: "volume_demo", health_status: "healthy",
  };
  const validator = Schema.Compile(RuntimeContainerSchema);
  assert.equal(validator.Check({ ...base, image_ref: `registry.example/core-agent@sha256:${"a".repeat(64)}` }), true);
  assert.equal(validator.Check({ ...base, image_ref: "registry.example/core-agent:latest" }), false);
});

test("clients cannot report observed state and volume deletion stays explicit", () => {
  assert.deepEqual(validateContainerMutation("client", { observed_state: "ready" }).map((item) => item.code), ["CLIENT_CANNOT_SET_OBSERVED_STATE"]);
  assert.deepEqual(resolveContainerDeletion({ desired_state: "deleted", delete_volume_requested: false }), { delete_container: true, delete_volume: false });
  assert.deepEqual(resolveContainerDeletion({ desired_state: "deleted", delete_volume_requested: true }), { delete_container: true, delete_volume: true });
});

test("terminal execution and approval states cannot be overwritten", () => {
  assert.equal(canTransitionAgentRun("succeeded", "running"), false);
  assert.equal(canTransitionTask("cancelled", "running"), false);
  assert.equal(canTransitionApproval("approved", "rejected"), false);
});

test("all resource state machines expose allowed and denied transitions", () => {
  assert.equal(canTransitionTenant("active", "suspended"), true);
  assert.equal(canTransitionMembership("revoked", "active"), false);
  assert.equal(canTransitionProfile("archived", "active"), false);
  assert.equal(canTransitionSession("expired", "active"), false);
});

test("conversation case binding cannot be silently replaced", () => {
  assert.deepEqual(
    validateConversationScopeChange(
      { student_id: "student_demo", case_id: "case_one" },
      { student_id: "student_demo", case_id: "case_two" },
    ).map((item) => item.code),
    ["CONVERSATION_CASE_IMMUTABLE"],
  );
});

test("a retry must have a new run id and point to the failed run", () => {
  assert.deepEqual(
    validateRetryRun(
      { run_id: "run_failed", status: "failed" },
      { run_id: "run_retry", parent_run_id: "run_failed", status: "queued" },
    ),
    [],
  );
  assert.deepEqual(
    validateRetryRun(
      { run_id: "run_failed", status: "failed" },
      { run_id: "run_failed", parent_run_id: "run_failed", status: "running" },
    ).map((item) => item.code).sort(),
    ["RETRY_MUST_CREATE_NEW_RUN", "RETRY_MUST_START_QUEUED"],
  );
});
```

- [ ] 运行：

```bash
node --import tsx --test --test-name-pattern="container transitions|runtime container|clients cannot|terminal execution|state machines|case binding|retry" packages/contracts/tests/*.test.ts
```

Expected: 失败，缺少运行资源和转换函数。

#### Step 2: 实现 Approval 和运行资源 Schema

- [ ] 在 `packages/contracts/src/approval/schema.ts` 定义：

```ts
import Type, { type Static } from "typebox";
import { OpaqueIdSchema, ResourceMetadataFields, UtcTimestampSchema } from "../common/primitives.js";

export const ApprovalStatusSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"),
  Type.Literal("expired"), Type.Literal("cancelled"),
]);

export const ApprovalSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    approval_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    task_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    requested_action: OpaqueIdSchema,
    summary: Type.String({ minLength: 1, maxLength: 1000 }),
    status: ApprovalStatusSchema,
    requester_actor_id: OpaqueIdSchema,
    decision_actor_id: Type.Optional(OpaqueIdSchema),
    requested_at: UtcTimestampSchema,
    decided_at: Type.Optional(UtcTimestampSchema),
    decision_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    trusted_context_version: Type.Integer({ minimum: 1 }),
    expires_at: Type.Optional(UtcTimestampSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/approval" },
);

export type Approval = Static<typeof ApprovalSchema>;
```

- [ ] 在 `packages/contracts/src/runtime/resources.ts` 定义并导出以下精确资源和状态字段：

| Schema | 必填身份与关联字段 | 状态与执行字段 |
|---|---|---|
| `RuntimeContainerSchema` | `container_id`, `tenant_id`, `runtime_kind: hermes` | `desired_state`, `observed_state`, `image_ref`, `generation`, `volume_ref`, `health_status`, `last_probed_at?`, `failure_summary?` |
| `ConversationSchema` | `conversation_id`, `tenant_id`, `profile_id`, `created_by_actor_id` | `status`, `student_ref?`, `case_ref?` |
| `SessionSchema` | `session_id`, `tenant_id`, `profile_id`, `actor_id`, `conversation_id` | `status`, `last_active_at`, `expires_at`, `hermes_session_ref?` |
| `AgentRunSchema` | `run_id`, `tenant_id`, `conversation_id`, `request_id`, `trace_id`, `client_request_id`, `idempotency_key` | `parent_run_id?`, `status`, `started_at?`, `finished_at?`, `failure_summary?` |
| `TaskSchema` | `task_id`, `tenant_id`, `origin_run_id`, `idempotency_key` | `capability_id?`, `student_ref?`, `case_ref?`, `status`, `attempt_count`, `dependency_status`, `result_summary?` |

使用这些精确枚举：

```ts
export const ContainerDesiredStateSchema = Type.Union([
  Type.Literal("running"), Type.Literal("stopped"), Type.Literal("deleted"),
]);
export const ContainerObservedStateSchema = Type.Union([
  Type.Literal("requested"), Type.Literal("provisioning"), Type.Literal("starting"),
  Type.Literal("ready"), Type.Literal("draining"), Type.Literal("upgrading"),
  Type.Literal("recovering"), Type.Literal("stopping"), Type.Literal("stopped"),
  Type.Literal("failed"), Type.Literal("deleting"), Type.Literal("deleted"),
]);
export const ContainerHealthStatusSchema = Type.Union([
  Type.Literal("unknown"), Type.Literal("healthy"), Type.Literal("degraded"), Type.Literal("unhealthy"),
]);
export const ConversationStatusSchema = Type.Union([
  Type.Literal("active"), Type.Literal("archived"), Type.Literal("closed"),
]);
export const SessionStatusSchema = Type.Union([
  Type.Literal("active"), Type.Literal("idle"), Type.Literal("expired"), Type.Literal("closed"),
]);
export const AgentRunStatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("running"), Type.Literal("waiting_approval"),
  Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"),
]);
export const TaskStatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("running"), Type.Literal("waiting_approval"),
  Type.Literal("paused"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"),
]);
export const DependencyStatusSchema = Type.Union([
  Type.Literal("not_checked"), Type.Literal("ready"), Type.Literal("blocked"), Type.Literal("unavailable"),
]);
```

每个资源必须由 `Type.Object({ ...ResourceMetadataFields, 资源字段 }, { additionalProperties: false, $id })` 组成；不能用带 `additionalProperties: false` 的元数据对象做 `allOf` 交集，否则资源自有字段会被元数据子 Schema 拒绝。字符串摘要最大 1000 字符；`attempt_count >= 0`、`generation >= 1`；`image_ref` 使用 `^.+@sha256:[a-f0-9]{64}$` 强制不可变 digest，`volume_ref` 保持不透明。导出每个 Schema 对应的 `Static` 类型。

#### Step 3: 实现显式状态转换矩阵

- [ ] 创建 `packages/contracts/src/runtime/transitions.ts`，每个状态表都是只读常量，公共 helper 只检查表，不自行推断：

```ts
type TransitionTable<State extends string> = Readonly<Record<State, readonly State[]>>;

function allows<State extends string>(table: TransitionTable<State>, from: State, to: State): boolean {
  return table[from].includes(to);
}

const tenantTransitions = {
  provisioning: ["active", "closing"], active: ["suspended", "closing"],
  suspended: ["active", "closing"], closing: ["closed"], closed: [],
} as const;

const membershipTransitions = {
  invited: ["active", "revoked"], active: ["suspended", "revoked"],
  suspended: ["active", "revoked"], revoked: [],
} as const;

const profileTransitions = {
  provisioning: ["active", "archived"], active: ["suspended", "archived"],
  suspended: ["active", "archived"], archived: [],
} as const;

const sessionTransitions = {
  active: ["idle", "expired", "closed"], idle: ["active", "expired", "closed"],
  expired: [], closed: [],
} as const;

const runTransitions = {
  queued: ["running", "cancelled"], running: ["waiting_approval", "succeeded", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"], succeeded: [], failed: [], cancelled: [],
} as const;

const taskTransitions = {
  queued: ["running", "cancelled"], running: ["waiting_approval", "paused", "succeeded", "failed", "cancelled"],
  waiting_approval: ["running", "paused", "failed", "cancelled"], paused: ["queued", "cancelled"],
  succeeded: [], failed: [], cancelled: [],
} as const;

const approvalTransitions = {
  pending: ["approved", "rejected", "expired", "cancelled"],
  approved: [], rejected: [], expired: [], cancelled: [],
} as const;

const containerTransitions = {
  requested: ["provisioning", "failed", "deleting"],
  provisioning: ["starting", "failed", "deleting"],
  starting: ["ready", "failed", "stopping", "deleting"],
  ready: ["draining", "upgrading", "recovering", "stopping", "failed", "deleting"],
  draining: ["ready", "upgrading", "stopping", "failed", "deleting"],
  upgrading: ["starting", "ready", "recovering", "failed", "deleting"],
  recovering: ["starting", "ready", "failed", "deleting"],
  stopping: ["stopped", "failed", "deleting"],
  stopped: ["starting", "failed", "deleting"],
  failed: ["recovering", "stopping", "deleting"],
  deleting: ["deleted", "failed"],
  deleted: [],
} as const;
```

导出八个类型安全函数：`canTransitionTenant`、`canTransitionMembership`、`canTransitionProfile`、`canTransitionSession`、`canTransitionAgentRun`、`canTransitionTask`、`canTransitionApproval`、`canTransitionContainerObservedState`。每个函数只调用 `allows` 对应表。

#### Step 4: 实现跨资源纯校验器

- [ ] 创建 `packages/contracts/src/runtime/invariants.ts`，实现并导出：

```ts
import { type ContractViolation, violation } from "../common/validation.js";

export function validateConversationScopeChange(
  previous: { student_id?: string; case_id?: string },
  next: { student_id?: string; case_id?: string },
): ContractViolation[] {
  if (previous.case_id !== undefined && previous.case_id !== next.case_id) {
    return [violation("CONVERSATION_CASE_IMMUTABLE", "case_ref.case_id", "Create a new conversation to change case scope")];
  }
  if (previous.student_id !== undefined && previous.student_id !== next.student_id) {
    return [violation("CONVERSATION_STUDENT_IMMUTABLE", "student_ref.student_id", "Create a new conversation to change student scope")];
  }
  return [];
}

export function validateRetryRun(
  previous: { run_id: string; status: string },
  next: { run_id: string; parent_run_id?: string; status: string },
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  if (previous.status !== "failed") violations.push(violation("RETRY_SOURCE_NOT_FAILED", "parent_run_id", "Only a failed run can be retried"));
  if (next.run_id === previous.run_id) violations.push(violation("RETRY_MUST_CREATE_NEW_RUN", "run_id", "Retry must create a new run"));
  if (next.parent_run_id !== previous.run_id) violations.push(violation("RETRY_PARENT_MISMATCH", "parent_run_id", "Retry must reference the failed run"));
  if (next.status !== "queued") violations.push(violation("RETRY_MUST_START_QUEUED", "status", "Retry must start in queued state"));
  return violations;
}

export function validateContainerMutation(
  source: "client" | "runtime_controller",
  patch: { desired_state?: string; observed_state?: string },
): ContractViolation[] {
  return source === "client" && patch.observed_state !== undefined
    ? [violation("CLIENT_CANNOT_SET_OBSERVED_STATE", "observed_state", "Only the runtime controller can report observed state")]
    : [];
}

export function resolveContainerDeletion(input: {
  desired_state: string;
  delete_volume_requested: boolean;
}): { delete_container: boolean; delete_volume: boolean } {
  return {
    delete_container: input.desired_state === "deleted",
    delete_volume: input.desired_state === "deleted" && input.delete_volume_requested,
  };
}
```

同文件增加 `RuntimeGraph` 和 `validateRuntimeGraph(graph)`，按下面顺序执行全部检查：

- Container、Conversation、Session、Run、Task、Approval 的 `tenant_id` 等于图的 `tenant_id`，否则 `TENANT_SCOPE_MISMATCH`；
- Session 的 `profile_id` 和 `conversation_id` 与目标资源一致；
- Run 的 `conversation_id` 存在；Task 的 `origin_run_id` 存在；Approval 的 `run_id` / `task_id` 存在且互相匹配；
- 所有出现的 `case_ref` 调用 `validateCaseScope`；
- Container 删除与 Volume 删除复用 `resolveContainerDeletion` 的独立布尔结果，不在 `validateRuntimeGraph` 中推导隐式删除。

#### Step 5: 导出、绿灯与提交

- [ ] 在 `packages/contracts/src/index.ts` 追加本任务五个模块的导出。
- [ ] 运行：

```bash
npm run contracts:test
npm run contracts:build
git diff --check
```

Expected: 所有转换矩阵与运行图测试通过；终态无任何出边；TypeScript strict build 通过。

- [ ] 提交：

```bash
git add packages/contracts/src packages/contracts/tests/runtime.test.ts
git commit -m "feat(contracts): define runtime resources and lifecycles"
```

**Reviewer Gate:** 审阅者逐项核对八类状态矩阵；确认客户端期望状态与平台 observed state 是不同字段；确认 Conversation、Session、Run、Task、Approval 的生命周期没有被合并；确认 Volume 删除为独立显式意图。

---

### Task 5: 实现 TrustedRequestContext、签名传输边界与 fail-closed 语义

**Interfaces:**

- Consumes: Identity/Profile、Student/Case/Snapshot refs、Container/Conversation/Run IDs。
- Produces: `TrustedRequestContextSchema`、`SignedTrustedRequestContextSchema`、`validateTrustedRequestContext`、`validateSignedContextEnvelope`。
- Security boundary: 这里只校验 payload 和 envelope 语义；真正的密码学签名验证明确留给后续 Identity Runtime，调用方不得把本函数当作签名验证。

**Files:**

- Create: `packages/contracts/src/request-context/trusted-request-context.ts`
- Create: `packages/contracts/tests/trusted-request-context.test.ts`
- Modify: `packages/contracts/src/index.ts`

#### Step 1: 写可信上下文红灯测试

- [ ] 创建 `packages/contracts/tests/trusted-request-context.test.ts`，基线 Context 必须是合成数据：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  SignedTrustedRequestContextSchema,
  TrustedRequestContextSchema,
  validateSignedContextEnvelope,
  validateTrustedRequestContext,
  type TrustedRequestContext,
} from "../src/index.js";

const context: TrustedRequestContext = {
  schema_version: 1,
  tenant_mode: "b2b",
  tenant_id: "tenant_demo",
  actor_id: "actor_consultant",
  original_actor_id: "actor_consultant",
  membership_id: "membership_demo",
  effective_role: "consultant",
  profile_id: "profile_demo",
  student_ref: { student_id: "student_demo", source_system: "eduapply" },
  case_ref: { case_id: "case_demo", student_id: "student_demo", capability_id: "eduapply.application" },
  entitlement_snapshot_ref: { snapshot_id: "entitlement_demo", version: 7, evaluated_at: "2026-08-03T01:00:00Z" },
  capability_ids: ["eduapply.application"],
  container_id: "container_demo",
  conversation_id: "conversation_demo",
  run_id: "run_demo",
  request_id: "request_demo",
  trace_id: "trace_demo",
  client_request_id: "client_request_demo",
  context_id: "context_demo",
  issuer: "core-agent-control-plane",
  audience: ["capability-gateway"],
  issued_at: "2026-08-03T01:00:00Z",
  expires_at: "2026-08-03T01:05:00Z",
  key_id: "key_demo",
};

const authority = {
  expected_issuer: "core-agent-control-plane",
  expected_audience: "capability-gateway",
  now: "2026-08-03T01:02:00Z",
  membership: {
    membership_id: "membership_demo",
    tenant_id: "tenant_demo",
    actor_id: "actor_consultant",
    roles: ["consultant"] as const,
    status: "active" as const,
  },
  profile: {
    profile_id: "profile_demo",
    tenant_id: "tenant_demo",
    owner_actor_id: "actor_consultant",
    status: "active" as const,
  },
};

test("accepts a short-lived server-derived context", () => {
  assert.equal(Schema.Compile(TrustedRequestContextSchema).Check(context), true);
  assert.deepEqual(validateTrustedRequestContext(context, authority), []);
});

test("rejects expiration, wrong audience, and forged role", () => {
  assert.deepEqual(
    validateTrustedRequestContext(context, { ...authority, now: "2026-08-03T01:06:00Z", expected_audience: "audit-runtime", membership: { ...authority.membership, roles: ["student"] } })
      .map((item) => item.code).sort(),
    ["CONTEXT_AUDIENCE_MISMATCH", "CONTEXT_EXPIRED", "EFFECTIVE_ROLE_NOT_GRANTED"],
  );
});

test("rejects suspended memberships and excessive TTL", () => {
  const longLived = { ...context, expires_at: "2026-08-03T01:10:00Z" };
  assert.deepEqual(
    validateTrustedRequestContext(longLived, { ...authority, membership: { ...authority.membership, status: "suspended" } })
      .map((item) => item.code).sort(),
    ["CONTEXT_TTL_EXCEEDED", "MEMBERSHIP_NOT_ACTIVE"],
  );
});

test("requires explicit delegation when an admin targets another owner profile", () => {
  const delegated = { ...context, actor_id: "actor_admin", original_actor_id: "actor_admin", membership_id: "membership_admin", effective_role: "admin" as const };
  const adminAuthority = {
    ...authority,
    membership: { membership_id: "membership_admin", tenant_id: "tenant_demo", actor_id: "actor_admin", roles: ["admin"] as const, status: "active" as const },
  };
  assert.deepEqual(validateTrustedRequestContext(delegated, adminAuthority).map((item) => item.code), ["DELEGATION_REQUIRED"]);
});

test("signed envelope metadata must match payload metadata", () => {
  const envelope = { schema_version: 1 as const, algorithm: "EdDSA" as const, key_id: "key_other", payload: context, signature: "synthetic_signature" };
  assert.equal(Schema.Compile(SignedTrustedRequestContextSchema).Check(envelope), true);
  assert.deepEqual(validateSignedContextEnvelope(envelope).map((item) => item.code), ["CONTEXT_KEY_ID_MISMATCH"]);
});
```

- [ ] 运行：

```bash
node --import tsx --test --test-name-pattern="server-derived|expiration|suspended|delegation|signed envelope" packages/contracts/tests/*.test.ts
```

Expected: 失败，缺少 Trusted Context 导出。

#### Step 2: 实现 payload 与 envelope Schema

- [ ] 创建 `packages/contracts/src/request-context/trusted-request-context.ts`，Schema 必须使用以下字段：

```ts
import Type, { type Static } from "typebox";

import { OpaqueIdSchema, SchemaVersionSchema, UtcTimestampSchema } from "../common/primitives.js";
import { type ContractViolation, violation } from "../common/validation.js";
import { ProfileStatusSchema } from "../profile/profile.js";
import { CaseRefSchema, ConsentSnapshotRefSchema, EntitlementSnapshotRefSchema, StudentRefSchema, validateCaseScope } from "../runtime/refs.js";
import { MembershipRoleSchema, MembershipStatusSchema, TenantModeSchema } from "../tenant/identity.js";

export const TrustedRequestContextSchema = Type.Object({
  schema_version: SchemaVersionSchema,
  tenant_mode: TenantModeSchema,
  tenant_id: OpaqueIdSchema,
  actor_id: OpaqueIdSchema,
  original_actor_id: OpaqueIdSchema,
  membership_id: OpaqueIdSchema,
  effective_role: MembershipRoleSchema,
  profile_id: OpaqueIdSchema,
  student_ref: Type.Optional(StudentRefSchema),
  case_ref: Type.Optional(CaseRefSchema),
  entitlement_snapshot_ref: EntitlementSnapshotRefSchema,
  consent_snapshot_ref: Type.Optional(ConsentSnapshotRefSchema),
  capability_ids: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
  container_id: OpaqueIdSchema,
  conversation_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
  request_id: OpaqueIdSchema,
  trace_id: OpaqueIdSchema,
  client_request_id: OpaqueIdSchema,
  context_id: OpaqueIdSchema,
  issuer: OpaqueIdSchema,
  audience: Type.Array(OpaqueIdSchema, { minItems: 1, uniqueItems: true }),
  issued_at: UtcTimestampSchema,
  expires_at: UtcTimestampSchema,
  key_id: OpaqueIdSchema,
  delegation_id: Type.Optional(OpaqueIdSchema),
  delegation_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  target_profile_id: Type.Optional(OpaqueIdSchema),
}, { additionalProperties: false, $id: "core-agent://v1/trusted-request-context" });

export const SignedTrustedRequestContextSchema = Type.Object({
  schema_version: SchemaVersionSchema,
  algorithm: Type.Literal("EdDSA"),
  key_id: OpaqueIdSchema,
  payload: TrustedRequestContextSchema,
  signature: Type.String({ minLength: 1 }),
}, { additionalProperties: false, $id: "core-agent://v1/signed-trusted-request-context" });

export type TrustedRequestContext = Static<typeof TrustedRequestContextSchema>;
export type SignedTrustedRequestContext = Static<typeof SignedTrustedRequestContextSchema>;
```

`signature` 只是 wire 字段，测试值必须明确标记为 synthetic；不得添加签名生成或验证函数。

#### Step 3: 实现服务端事实对照验证

- [ ] 同文件增加以下 authority 输入：

```ts
export interface TrustedContextAuthority {
  expected_issuer: string;
  expected_audience: string;
  now: string;
  membership: {
    membership_id: string;
    tenant_id: string;
    actor_id: string;
    roles: readonly ("admin" | "consultant" | "student")[];
    status: Static<typeof MembershipStatusSchema>;
  };
  profile: {
    profile_id: string;
    tenant_id: string;
    owner_actor_id: string;
    status: Static<typeof ProfileStatusSchema>;
  };
}
```

- [ ] `validateTrustedRequestContext(context, authority)` 按固定顺序返回违规：

1. `MEMBERSHIP_NOT_ACTIVE`：Membership 非 active；
2. `TENANT_SCOPE_MISMATCH`：Context、Membership、Profile tenant 不一致；
3. `MEMBERSHIP_CONTEXT_MISMATCH`：membership/actor ID 不一致；
4. `PROFILE_CONTEXT_MISMATCH`：profile ID 不一致或 Profile 非 active；
5. `EFFECTIVE_ROLE_NOT_GRANTED`：role 不在 Membership roles；
6. `CONTEXT_ISSUER_MISMATCH`：issuer 不同；
7. `CONTEXT_AUDIENCE_MISMATCH`：expected audience 不在数组；
8. `CONTEXT_NOT_YET_VALID` / `CONTEXT_EXPIRED`：用 `Date.parse` 比较固定 `authority.now`；
9. `CONTEXT_TTL_EXCEEDED`：`expires_at - issued_at > 300_000`；
10. 追加 `validateCaseScope` 的结果；
11. `DELEGATION_FIELDS_INCOMPLETE`：`delegation_id`、`delegation_reason`、`target_profile_id` 不是同时存在或同时缺失；
12. `DELEGATION_REQUIRED`：Profile owner 与 actor 不同而没有 `delegation_id`；
13. `DELEGATION_TARGET_MISMATCH`：`target_profile_id` 与 `profile_id` 不同；
14. `ORIGINAL_ACTOR_MISMATCH`：无 delegation 时 `original_actor_id !== actor_id`。

- [ ] `validateSignedContextEnvelope(envelope)` 只检查：外层和 payload `schema_version` 相同、`key_id` 相同、algorithm 恰为 `EdDSA`。函数注释必须明确写出：调用成功不代表签名有效。

#### Step 4: 绿灯、构建与提交

- [ ] 在 `packages/contracts/src/index.ts` 导出该模块。
- [ ] 运行：

```bash
npm run contracts:test
npm run contracts:build
git diff --check
```

Expected: Context 测试全部通过；没有随机时间依赖；测试不声称 synthetic signature 已通过密码学验证。

- [ ] 提交：

```bash
git add packages/contracts/src packages/contracts/tests/trusted-request-context.test.ts
git commit -m "feat(contracts): define trusted request context"
```

**Reviewer Gate:** 安全审阅者确认客户端不能构造 authority 输入；所有敏感冲突 fail closed；5 分钟 TTL 使用绝对毫秒；三个 delegation 字段必须成组出现；签名语义没有被伪实现。

---

### Task 6: 实现 ProductEvent、AuditEvent 和 ErrorEnvelope

**Interfaces:**

- Consumes: 通用 ID/时间、资源关联 ID、Student/Case/Snapshot refs、运行状态。
- Produces: 产品流的基础 envelope、所有 v1 已知事件族、unknown-event fallback、服务端 AuditEvent、稳定 ErrorEnvelope。
- Privacy: 事件与错误拒绝多余字段，禁止隐藏推理、原始密钥、完整敏感 Tool 参数和内部 stack。

**Files:**

- Create: `packages/contracts/src/events/product-event.ts`
- Create: `packages/contracts/src/audit/audit-event.ts`
- Create: `packages/contracts/src/errors/error-envelope.ts`
- Create: `packages/contracts/tests/product-event.test.ts`
- Modify: `packages/contracts/src/index.ts`

#### Step 1: 写事件、审计与错误红灯测试

- [ ] 创建 `packages/contracts/tests/product-event.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  AuditEventSchema,
  ErrorEnvelopeSchema,
  ProductEventSchema,
  classifyProductEvent,
} from "../src/index.js";

const base = {
  schema_version: 1 as const,
  event_id: "event_demo",
  event_type: "message.delta" as const,
  occurred_at: "2026-08-03T01:02:03Z",
  sequence: 4,
  tenant_id: "tenant_demo",
  request_id: "request_demo",
  trace_id: "trace_demo",
  correlation_id: "conversation_demo",
  causation_id: "run_demo",
  conversation_id: "conversation_demo",
  run_id: "run_demo",
  payload: { message_id: "message_demo", delta: "Hello" },
};

test("accepts a typed message delta and rejects hidden reasoning", () => {
  assert.equal(Schema.Compile(ProductEventSchema).Check(base), true);
  assert.equal(Schema.Compile(ProductEventSchema).Check({ ...base, payload: { ...base.payload, hidden_reasoning: "private" } }), false);
});

test("classifies unknown events without breaking the cursor consumer", () => {
  assert.equal(classifyProductEvent({ ...base, event_type: "future.event", payload: {} }), "unknown");
  assert.equal(classifyProductEvent({ ...base, event_id: "" }), "invalid");
});

test("audit events are server-shaped and redacted", () => {
  const audit = {
    schema_version: 1,
    audit_event_id: "audit_demo",
    occurred_at: "2026-08-03T01:02:03Z",
    tenant_id: "tenant_demo",
    actor_id: "actor_demo",
    membership_id: "membership_demo",
    effective_role: "consultant",
    action: "application.review",
    resource_type: "case",
    resource_id: "case_demo",
    decision: "allowed",
    outcome: "succeeded",
    request_id: "request_demo",
    trace_id: "trace_demo",
    reason_summary: "Policy checks passed",
  };
  assert.equal(Schema.Compile(AuditEventSchema).Check(audit), true);
  assert.equal(Schema.Compile(AuditEventSchema).Check({ ...audit, api_key: "synthetic" }), false);
});

test("error envelope exposes stable machine semantics", () => {
  const error = {
    schema_version: 1,
    error_id: "error_demo",
    code: "APPROVAL_REQUIRED",
    category: "authorization",
    message: "Approval is required before this action",
    retryable: false,
    request_id: "request_demo",
    trace_id: "trace_demo",
  };
  assert.equal(Schema.Compile(ErrorEnvelopeSchema).Check(error), true);
  assert.equal(Schema.Compile(ErrorEnvelopeSchema).Check({ ...error, stack: "internal stack" }), false);
});
```

- [ ] 运行：

```bash
node --import tsx --test --test-name-pattern="typed message|unknown events|audit events|error envelope" packages/contracts/tests/*.test.ts
```

Expected: 失败，事件、审计和错误模块尚不存在。

#### Step 2: 实现产品事件 envelope 与八个类型化事件族

- [ ] 在 `packages/contracts/src/events/product-event.ts` 先定义基础字段：

```ts
import Type, { type Static } from "typebox";
import Schema from "typebox/schema";

import { OpaqueIdSchema, SchemaVersionSchema, SequenceSchema, UtcTimestampSchema } from "../common/primitives.js";
import { ApprovalStatusSchema } from "../approval/schema.js";
import { AgentRunStatusSchema, ContainerObservedStateSchema, TaskStatusSchema } from "../runtime/resources.js";
import { CaseRefSchema, StudentRefSchema } from "../runtime/refs.js";

const EventAssociationFields = {
  profile_id: Type.Optional(OpaqueIdSchema),
  conversation_id: Type.Optional(OpaqueIdSchema),
  run_id: Type.Optional(OpaqueIdSchema),
  task_id: Type.Optional(OpaqueIdSchema),
  approval_id: Type.Optional(OpaqueIdSchema),
  student_ref: Type.Optional(StudentRefSchema),
  case_ref: Type.Optional(CaseRefSchema),
  capability_id: Type.Optional(OpaqueIdSchema),
} as const;

const ProductEventBaseFields = {
  schema_version: SchemaVersionSchema,
  event_id: OpaqueIdSchema,
  occurred_at: UtcTimestampSchema,
  sequence: SequenceSchema,
  tenant_id: OpaqueIdSchema,
  request_id: OpaqueIdSchema,
  trace_id: OpaqueIdSchema,
  correlation_id: OpaqueIdSchema,
  causation_id: OpaqueIdSchema,
  ...EventAssociationFields,
} as const;

export const ProductEventEnvelopeSchema = Type.Object({
  ...ProductEventBaseFields,
  event_type: OpaqueIdSchema,
  payload: Type.Unknown(),
}, { additionalProperties: false, $id: "core-agent://v1/product-event-envelope" });
```

- [ ] 定义八个已知事件族，全部使用 `Type.Object({ ...ProductEventBaseFields, event_type, payload }, { additionalProperties: false })`：

| 事件族 Schema | `event_type` literal union | payload 必填字段 |
|---|---|---|
| `ConversationEventSchema` | `conversation.created`, `conversation.archived` | `conversation_id`, `status` |
| `RunEventSchema` | `run.queued`, `run.started`, `run.waiting_approval`, `run.completed`, `run.failed`, `run.cancelled` | `run_id`, `status: AgentRunStatusSchema`, `summary?` |
| `MessageDeltaEventSchema` | `message.delta` | `message_id`, `delta` |
| `MessageCompletedEventSchema` | `message.completed` | `message_id`, `content` |
| `TaskEventSchema` | `task.created`, `task.status_changed` | `task_id`, `status: TaskStatusSchema` |
| `ApprovalEventSchema` | `approval.requested`, `approval.resolved` | `approval_id`, `status: ApprovalStatusSchema` |
| `ToolEventSchema` | `tool.requested`, `tool.started`, `tool.succeeded`, `tool.failed` | `tool_call_id`, `tool_name`, `status: requested|started|succeeded|failed`, `summary?` |
| `RuntimeEventSchema` | `runtime.status_changed` | `container_id`, `observed_state: ContainerObservedStateSchema` |
| `ErrorReportedEventSchema` | `error.reported` | `error_id`, `code`, `category` |

所有事件族 Schema 都设置稳定 `$id: core-agent://v1/<family>-event`，所有 payload 都设置 `additionalProperties: false`；`summary`、`content` 最大 4000 字符；`delta` 最大 16,000 字符；Tool payload 不允许 `arguments`、`raw_input`、`raw_output`；消息 payload 不允许 `hidden_reasoning`、`chain_of_thought`。

每个 `event_type` literal union 都必须设置 `"x-extensible-union": true`，因为 ProductEvent consumer 已有 unknown fallback，v1 才能按 Minor 增加可忽略事件。状态、角色和授权枚举不得添加这个标记。

- [ ] 定义已知 union 与 fallback：

```ts
export const ProductEventSchema = Type.Union([
  ConversationEventSchema,
  RunEventSchema,
  MessageDeltaEventSchema,
  MessageCompletedEventSchema,
  TaskEventSchema,
  ApprovalEventSchema,
  ToolEventSchema,
  RuntimeEventSchema,
  ErrorReportedEventSchema,
], { $id: "core-agent://v1/product-event", "x-extensible-union": true });

const envelopeValidator = Schema.Compile(ProductEventEnvelopeSchema);
const knownEventValidator = Schema.Compile(ProductEventSchema);

export type ProductEvent = Static<typeof ProductEventSchema>;
export type ProductEventEnvelope = Static<typeof ProductEventEnvelopeSchema>;

export function classifyProductEvent(value: unknown): "known" | "unknown" | "invalid" {
  if (!envelopeValidator.Check(value)) return "invalid";
  return knownEventValidator.Check(value) ? "known" : "unknown";
}
```

Unknown fallback 只允许消费者保留 cursor 并忽略未知类型；生产者仍必须通过严格 `ProductEventSchema`。

#### Step 3: 实现 AuditEvent 与 ErrorEnvelope

- [ ] `packages/contracts/src/audit/audit-event.ts` 定义 `AuditEventSchema`，必填字段与测试一致，并增加以下可选字段：

```text
delegation_id, delegation_reason, run_id, task_id, approval_id,
policy_version, entitlement_snapshot_ref, consent_snapshot_ref,
change_summary, resource_version
```

`decision` 只能是 `allowed | denied | not_applicable`；`outcome` 只能是 `succeeded | failed | cancelled | pending`；`reason_summary` 和 `change_summary` 最大 2000 字符；对象 `additionalProperties: false`。导出 `AuditEvent` 静态类型。

- [ ] `packages/contracts/src/errors/error-envelope.ts` 定义：

```ts
export const ErrorCategorySchema = Type.Union([
  Type.Literal("validation"), Type.Literal("authentication"), Type.Literal("authorization"),
  Type.Literal("conflict"), Type.Literal("rate_limit"), Type.Literal("dependency"),
  Type.Literal("unavailable"), Type.Literal("timeout"), Type.Literal("internal"),
]);

export const StableErrorCodeSchema = Type.Union([
  Type.Literal("TENANT_SCOPE_MISMATCH"), Type.Literal("PROFILE_NOT_ACTIVE"),
  Type.Literal("CONTEXT_EXPIRED"), Type.Literal("ENTITLEMENT_DENIED"),
  Type.Literal("APPROVAL_REQUIRED"), Type.Literal("IDEMPOTENCY_CONFLICT"),
  Type.Literal("DEPENDENCY_UNAVAILABLE"), Type.Literal("INTERNAL_ERROR"),
], { "x-extensible-union": true });
```

`ErrorEnvelopeSchema` 必填 `schema_version`、`error_id`、`code`、`category`、`message`、`retryable`、`request_id`、`trace_id`；可选 `retry_after_ms >= 0`、`field_errors[]`（只允许 `path`、`code`、`message`）、`resource_type`、`resource_id`、`resource_version`、`current_state`。所有对象拒绝多余字段，`message` 最大 2000 字符。导出 `ErrorEnvelope`。

#### Step 4: 导出、绿灯与提交

- [ ] 在 `packages/contracts/src/index.ts` 追加三个模块导出。
- [ ] 运行：

```bash
npm run contracts:test
npm run contracts:build
git diff --check
```

Expected: known event、unknown fallback、AuditEvent 和 ErrorEnvelope 测试全部通过；添加 `hidden_reasoning`、`arguments`、`stack` 或 `api_key` 都会校验失败。

- [ ] 提交：

```bash
git add packages/contracts/src packages/contracts/tests/product-event.test.ts
git commit -m "feat(contracts): add product audit and error envelopes"
```

**Reviewer Gate:** 审阅者核对设计规格中的 20 个 event type 全部出现；未知事件只对消费者宽容；生产者、AuditEvent、ErrorEnvelope 保持严格；没有模型隐藏推理或敏感 Tool payload 字段。

---

### Task 7: 使幂等、事件交付、重试与 Approval 恢复语义可执行

**Interfaces:**

- Consumes: ProductEventEnvelope、AgentRun、Approval、Entitlement/Consent snapshot refs。
- Produces: 幂等请求/记录 Schema、带乐观并发版本的写请求 Schema、同 key 决策函数、单 stream event batch 消费函数、Approval 恢复重校验函数。
- Boundary: 不实现存储、消息 broker、HTTP retry 或领域副作用；只冻结调用方必须遵循的纯语义。

**Files:**

- Create: `packages/contracts/src/runtime/idempotency.ts`
- Create: `packages/contracts/src/runtime/delivery.ts`
- Create: `packages/contracts/tests/delivery.test.ts`
- Modify: `packages/contracts/src/index.ts`

#### Step 1: 写交付和幂等红灯测试

- [ ] 创建 `packages/contracts/tests/delivery.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  consumeEventBatch,
  resolveIdempotency,
  validateApprovalResume,
  VersionedWriteRequestSchema,
  type ProductEventEnvelope,
} from "../src/index.js";

test("same idempotency key and payload replays the stored result", () => {
  const payloadHash = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(
    resolveIdempotency(
      { idempotency_key: "idem_demo", payload_hash: payloadHash, result_ref: "run_demo" },
      { idempotency_key: "idem_demo", payload_hash: payloadHash },
    ),
    { decision: "replay", result_ref: "run_demo" },
  );
});

test("same idempotency key and different payload conflicts", () => {
  assert.deepEqual(
    resolveIdempotency(
      { idempotency_key: "idem_demo", payload_hash: `sha256:${"a".repeat(64)}`, result_ref: "run_demo" },
      { idempotency_key: "idem_demo", payload_hash: `sha256:${"b".repeat(64)}` },
    ),
    { decision: "conflict", error_code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("versioned writes require an optimistic concurrency version", () => {
  const validator = Schema.Compile(VersionedWriteRequestSchema);
  const request = { schema_version: 1, idempotency_key: "idem_demo", payload_hash: `sha256:${"a".repeat(64)}` };
  assert.equal(validator.Check(request), false);
  assert.equal(validator.Check({ ...request, expected_resource_version: 7 }), true);
});

const event = (eventId: string, sequence: number): ProductEventEnvelope => ({
  schema_version: 1,
  event_id: eventId,
  event_type: "future.event",
  occurred_at: "2026-08-03T01:02:03Z",
  sequence,
  tenant_id: "tenant_demo",
  request_id: "request_demo",
  trace_id: "trace_demo",
  correlation_id: "conversation_demo",
  causation_id: "run_demo",
  payload: {},
});

test("event consumer deduplicates at-least-once delivery", () => {
  assert.deepEqual(
    consumeEventBatch({ last_sequence: 3, seen_event_ids: ["event_old"] }, [event("event_four", 4), event("event_four", 4)]),
    { accepted: [event("event_four", 4)], cursor: { last_sequence: 4, seen_event_ids: ["event_old", "event_four"] }, violations: [] },
  );
});

test("event consumer reports out-of-order input without losing cursor", () => {
  const result = consumeEventBatch({ last_sequence: 3, seen_event_ids: [] }, [event("event_five", 5), event("event_four", 4)]);
  assert.deepEqual(result.violations.map((item) => item.code), ["EVENT_SEQUENCE_OUT_OF_ORDER"]);
  assert.equal(result.cursor.last_sequence, 5);
});

test("approval resume requires current authority versions", () => {
  assert.deepEqual(
    validateApprovalResume(
      { membership_status: "active", entitlement_version: 7, consent_version: 2, case_scope_valid: true },
      { membership_status: "active", entitlement_version: 8, consent_version: 2, case_scope_valid: true },
    ).map((item) => item.code),
    ["AUTHORITY_CHANGED_AFTER_APPROVAL"],
  );
});
```

- [ ] 运行：

```bash
node --import tsx --test --test-name-pattern="idempotency|event consumer|approval resume" packages/contracts/tests/*.test.ts
```

Expected: 失败，交付语义函数尚未实现。

#### Step 2: 实现幂等 Schema 与三态决策

- [ ] 创建 `packages/contracts/src/runtime/idempotency.ts`：

```ts
import Type, { type Static } from "typebox";
import { OpaqueIdSchema, ResourceVersionSchema, SchemaVersionSchema } from "../common/primitives.js";

export const PayloadHashSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
export const IdempotencyRequestFields = {
  schema_version: SchemaVersionSchema,
  idempotency_key: OpaqueIdSchema,
  payload_hash: PayloadHashSchema,
} as const;

export const IdempotencyRequestSchema = Type.Object(IdempotencyRequestFields, {
  additionalProperties: false,
  $id: "core-agent://v1/idempotency-request",
});

export const VersionedWriteRequestSchema = Type.Object({
  ...IdempotencyRequestFields,
  expected_resource_version: ResourceVersionSchema,
}, { additionalProperties: false, $id: "core-agent://v1/versioned-write-request" });

export const IdempotencyRecordSchema = Type.Object({
  schema_version: SchemaVersionSchema,
  tenant_id: OpaqueIdSchema,
  idempotency_key: OpaqueIdSchema,
  payload_hash: PayloadHashSchema,
  result_ref: OpaqueIdSchema,
}, { additionalProperties: false, $id: "core-agent://v1/idempotency-record" });

export type IdempotencyRequest = Static<typeof IdempotencyRequestSchema>;
export type IdempotencyRecord = Static<typeof IdempotencyRecordSchema>;
export type VersionedWriteRequest = Static<typeof VersionedWriteRequestSchema>;

export function resolveIdempotency(
  existing: Pick<IdempotencyRecord, "idempotency_key" | "payload_hash" | "result_ref"> | undefined,
  incoming: Pick<IdempotencyRequest, "idempotency_key" | "payload_hash">,
): { decision: "new" } | { decision: "replay"; result_ref: string } | { decision: "conflict"; error_code: "IDEMPOTENCY_CONFLICT" } {
  if (existing === undefined || existing.idempotency_key !== incoming.idempotency_key) return { decision: "new" };
  if (existing.payload_hash === incoming.payload_hash) return { decision: "replay", result_ref: existing.result_ref };
  return { decision: "conflict", error_code: "IDEMPOTENCY_CONFLICT" };
}
```

哈希由 Control Plane 对规范化 payload 计算；本包不选择 canonical JSON 实现，避免把序列化策略伪装成已冻结协议。`payload_hash` wire 格式固定为 `sha256:<lowercase hex>`。

#### Step 3: 实现单 stream cursor 与 Approval 恢复校验

- [ ] 创建 `packages/contracts/src/runtime/delivery.ts`，定义：

```ts
import { type ContractViolation, violation } from "../common/validation.js";
import { type ProductEventEnvelope } from "../events/product-event.js";

export interface EventCursor {
  last_sequence: number;
  seen_event_ids: string[];
}

export function consumeEventBatch(cursor: EventCursor, events: ProductEventEnvelope[]): {
  accepted: ProductEventEnvelope[];
  cursor: EventCursor;
  violations: ContractViolation[];
} {
  const seen = new Set(cursor.seen_event_ids);
  const accepted: ProductEventEnvelope[] = [];
  const violations: ContractViolation[] = [];
  let lastSequence = cursor.last_sequence;

  for (const event of events) {
    if (seen.has(event.event_id)) continue;
    if (event.sequence <= lastSequence) {
      violations.push(violation("EVENT_SEQUENCE_OUT_OF_ORDER", "sequence", "Event sequence moved backwards within one stream"));
      seen.add(event.event_id);
      continue;
    }
    seen.add(event.event_id);
    accepted.push(event);
    lastSequence = event.sequence;
  }
  return { accepted, cursor: { last_sequence: lastSequence, seen_event_ids: [...seen] }, violations };
}

export interface AuthoritySnapshot {
  membership_status: "active" | "suspended" | "revoked";
  entitlement_version: number;
  consent_version?: number;
  case_scope_valid: boolean;
}

export function validateApprovalResume(approved: AuthoritySnapshot, current: AuthoritySnapshot): ContractViolation[] {
  const violations: ContractViolation[] = [];
  if (current.membership_status !== "active") violations.push(violation("MEMBERSHIP_NOT_ACTIVE", "membership_status", "Membership must be active before execution"));
  if (!current.case_scope_valid) violations.push(violation("CASE_SCOPE_INVALID", "case_scope_valid", "Case scope must be revalidated before execution"));
  if (approved.entitlement_version !== current.entitlement_version || approved.consent_version !== current.consent_version) {
    violations.push(violation("AUTHORITY_CHANGED_AFTER_APPROVAL", "authority_snapshot", "Authority changed after approval and requires a new decision"));
  }
  return violations;
}
```

调用方必须只向 `consumeEventBatch` 传同一 Conversation/Run stream 的事件；跨 stream 分组是后续 Event Runtime 的职责。seen IDs 的持久化、压缩和 retention 不属于本包。

#### Step 4: 导出、绿灯与提交

- [ ] 在 `packages/contracts/src/index.ts` 导出两个模块。
- [ ] 运行：

```bash
npm run contracts:test
npm run contracts:build
git diff --check
```

Expected: new/replay/conflict 三态、重复事件、乱序事件、cursor 保留和授权版本变化全部通过。

- [ ] 提交：

```bash
git add packages/contracts/src packages/contracts/tests/delivery.test.ts
git commit -m "feat(contracts): codify idempotency and delivery semantics"
```

**Reviewer Gate:** 审阅者确认 helper 不执行外部副作用、不把失败 Run 原地复活、不因重复 Event 重复消费、Approval 后任何权威版本变化都会要求重新决策。

---

### Task 8: 生成 JSON Schema、建立 fixtures 与兼容性门禁

**Interfaces:**

- Consumes: 全部 TypeBox 作者源和纯语义验证器。
- Produces: `schemas/v1` 可分发 JSON Schema、`fixtures/v1` 合法/非法样例、`compat/v1` 不可覆盖的 v1 基线、生成漂移与破坏性变更检查。
- Compatibility policy: 删除字段、改变类型、增加 required、改变 const、收窄 literal union 一律破坏；只有标记 `x-extensible-union: true` 的 union 才允许增加分支。

**Files:**

- Create: `packages/contracts/src/registry.ts`
- Create: `packages/contracts/scripts/generate-schemas.ts`
- Create: `packages/contracts/scripts/verify-fixtures.ts`
- Create: `packages/contracts/scripts/check-compatibility.ts`
- Create: `packages/contracts/tests/schema-generation.test.ts`
- Create: `packages/contracts/tests/fixtures.test.ts`
- Create: `packages/contracts/tests/compatibility.test.ts`
- Create: `packages/contracts/fixtures/v1/valid/*.json`
- Create: `packages/contracts/fixtures/v1/invalid/*.json`
- Generate: `packages/contracts/schemas/v1/*.schema.json`
- Generate: `packages/contracts/compat/v1/*.schema.json`
- Modify: `packages/contracts/src/index.ts`

#### Step 1: 写生成、fixture 与兼容性红灯测试

- [ ] 创建 `packages/contracts/tests/schema-generation.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { ContractSchemas, serializeSchema } from "../src/index.js";

test("registry keys and schema ids are unique", () => {
  const ids = Object.values(ContractSchemas).map((schema) => schema.$id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(Object.keys(ContractSchemas).every((key) => /^[a-z0-9-]+$/.test(key)), true);
});

test("serialized schemas declare JSON Schema 2020-12", () => {
  const document = JSON.parse(serializeSchema(ContractSchemas.tenant));
  assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(document.$id, "core-agent://v1/tenant");
});
```

- [ ] 创建 `packages/contracts/tests/compatibility.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { compareSchemas } from "../scripts/check-compatibility.js";

test("detects property removal, type change, required addition, and union narrowing", () => {
  assert.deepEqual(compareSchemas({ type: "object", properties: { id: { type: "string" } } }, { type: "object", properties: {} }).map((item) => item.kind), ["property_removed"]);
  assert.deepEqual(compareSchemas({ type: "string" }, { type: "number" }).map((item) => item.kind), ["type_changed"]);
  assert.deepEqual(compareSchemas({ type: "object", properties: { note: { type: "string" } } }, { type: "object", required: ["note"], properties: { note: { type: "string" } } }).map((item) => item.kind), ["required_added"]);
  assert.deepEqual(compareSchemas({ anyOf: [{ const: "a" }, { const: "b" }] }, { anyOf: [{ const: "a" }] }).map((item) => item.kind), ["union_narrowed"]);
});

test("allows optional properties and explicitly extensible union growth", () => {
  assert.deepEqual(compareSchemas({ type: "object", properties: {} }, { type: "object", properties: { note: { type: "string" } } }), []);
  assert.deepEqual(compareSchemas(
    { anyOf: [{ const: "a" }], "x-extensible-union": true },
    { anyOf: [{ const: "a" }, { const: "b" }], "x-extensible-union": true },
  ), []);
});
```

- [ ] 创建 `packages/contracts/tests/fixtures.test.ts`，通过子进程执行 verifier 并要求退出码 0：

```ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("all committed fixtures match structural and semantic expectations", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-fixtures.ts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
```

- [ ] 运行：

```bash
node --import tsx --test --test-name-pattern="registry keys|serialized schemas|detects property|allows optional|committed fixtures" packages/contracts/tests/*.test.ts
```

Expected: 失败，registry 和 scripts 尚未创建。

#### Step 2: 建立完整 Schema registry 与确定性序列化

- [ ] 创建 `packages/contracts/src/registry.ts`。用 `satisfies Record<string, TSchema>` 导出 `ContractSchemas`，registry 必须包含以下固定 key，不能根据文件系统动态发现：

```text
resource-metadata
trace-context
page-request
page-info
student-ref
case-ref
entitlement-snapshot-ref
consent-snapshot-ref
tenant
actor
membership
profile
identity-graph
runtime-container
conversation
session
agent-run
task
approval
trusted-request-context
signed-trusted-request-context
product-event-envelope
product-event
audit-event
error-envelope
idempotency-request
idempotency-record
versioned-write-request
```

每个 key 映射到同名导入的 TypeBox Schema。不要把内部 helper schema 单独发布成未承诺的公共 wire contract。

- [ ] 同文件实现确定性序列化：

```ts
import type { TSchema } from "typebox";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

export function serializeSchema(schema: TSchema): string {
  const document = { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema };
  return `${JSON.stringify(sortJson(document), null, 2)}\n`;
}
```

- [ ] 在 `packages/contracts/src/index.ts` 导出 registry。

#### Step 3: 实现原子生成和 drift check

- [ ] 创建 `packages/contracts/scripts/generate-schemas.ts`：

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ContractSchemas, serializeSchema } from "../src/registry.js";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(root, "schemas/v1");
const checkOnly = process.argv.includes("--check");
const failures: string[] = [];

await mkdir(outputDirectory, { recursive: true });
for (const [key, schema] of Object.entries(ContractSchemas).sort(([left], [right]) => left.localeCompare(right))) {
  const outputPath = resolve(outputDirectory, `${key}.schema.json`);
  const expected = serializeSchema(schema);
  if (checkOnly) {
    const actual = await readFile(outputPath, "utf8").catch(() => "");
    if (actual !== expected) failures.push(outputPath);
    continue;
  }
  const temporaryPath = `${outputPath}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(temporaryPath, expected, "utf8");
  await rename(temporaryPath, outputPath);
}

if (failures.length > 0) {
  console.error(`Generated schema drift:\n${failures.join("\n")}`);
  process.exitCode = 1;
}
```

- [ ] 首次生成并确认随后 check 无差异：

```bash
npm run contracts:schemas
npm run schemas:check -w @core-agent/contracts
```

Expected: 第一条创建 28 个 `*.schema.json`；第二条无输出且退出码 0。

#### Step 4: 创建覆盖全部 registry 的匿名 fixtures

- [ ] 每个 registry key 创建一个 `fixtures/v1/valid/<key>.json`。fixture wrapper 格式固定为：

```json
{
  "schema_key": "tenant",
  "expected": {
    "structurally_valid": true,
    "violation_codes": []
  },
  "value": {
    "schema_version": 1,
    "resource_version": 1,
    "created_at": "2026-08-03T01:02:03Z",
    "updated_at": "2026-08-03T01:02:03Z",
    "tenant_id": "tenant_demo",
    "tenant_mode": "b2b",
    "display_name": "Demo tenant",
    "status": "active"
  }
}
```

其余 27 个 valid fixture 使用单元测试已经采用的合成 ID；每个对象必须包含其 Schema 的全部必填字段，不得用真实名称、邮箱、电话、学校、地址或业务文书。

- [ ] 创建以下非法 fixture，文件名、验证模式与期望 code 固定：

| 文件 | `schema_key` | `semantic_validator` | 期望 |
|---|---|---|---|
| `membership-empty-roles.json` | `membership` | 无 | `structurally_valid: false` |
| `resource-non-utc-time.json` | `tenant` | 无 | `structurally_valid: false` |
| `identity-cross-tenant.json` | `identity-graph` | `identity_graph` | `TENANT_SCOPE_MISMATCH` |
| `identity-b2c-consultant.json` | `identity-graph` | `identity_graph` | `B2C_PROFILE_KIND_INVALID` |
| `context-case-student-mismatch.json` | `trusted-request-context` | `trusted_context` | `CASE_STUDENT_MISMATCH` |
| `context-expired.json` | `trusted-request-context` | `trusted_context` | `CONTEXT_EXPIRED` |
| `context-forged-role.json` | `trusted-request-context` | `trusted_context` | `EFFECTIVE_ROLE_NOT_GRANTED` |
| `event-hidden-reasoning.json` | `product-event` | 无 | `structurally_valid: false` |
| `error-stack.json` | `error-envelope` | 无 | `structurally_valid: false` |

语义 fixture wrapper 额外包含 `semantic_validator`；`trusted_context` verifier 始终使用 Task 5 测试中的固定 synthetic authority 和 `now: 2026-08-03T01:02:00Z`。

#### Step 5: 实现 fixture verifier

- [ ] 创建 `packages/contracts/scripts/verify-fixtures.ts`，行为必须是：

1. 按路径排序读取 `fixtures/v1/valid/*.json` 和 `fixtures/v1/invalid/*.json`；
2. 解析 wrapper，拒绝未知 `schema_key`；
3. 用 `Schema.Compile(ContractSchemas[schema_key]).Check(value)` 得到 structural 结果；
4. `identity_graph` 调用 `validateIdentityGraph`；`trusted_context` 调用 `validateTrustedRequestContext`；
5. 将实际 violation codes 排序后与 wrapper 的 `expected.violation_codes` 精确比较；
6. 任一不符时打印相对路径和实际/期望，不打印完整 value；
7. 确认 valid 目录覆盖 `Object.keys(ContractSchemas)` 的每个 key，缺少任何合法 fixture 都失败；
8. 成功输出 `Verified 28 valid fixtures and 9 invalid fixtures`。

该脚本只能使用 Node 标准库、TypeBox 和包内验证函数；不得连接网络或读取环境凭据。

#### Step 6: 实现兼容性比较和冻结 v1 baseline

- [ ] 创建 `packages/contracts/scripts/check-compatibility.ts` 并导出：

```ts
export interface BreakingChange {
  kind: "property_removed" | "type_changed" | "required_added" | "const_changed" | "enum_narrowed" | "union_narrowed" | "union_growth_not_extensible";
  path: string;
  before?: unknown;
  after?: unknown;
}

export function compareSchemas(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  path = "$",
): BreakingChange[] {
  const changes: BreakingChange[] = [];
  if (previous.type !== undefined && current.type !== previous.type) changes.push({ kind: "type_changed", path, before: previous.type, after: current.type });
  if (previous.const !== undefined && current.const !== previous.const) changes.push({ kind: "const_changed", path, before: previous.const, after: current.const });

  const previousRequired = new Set(Array.isArray(previous.required) ? previous.required as string[] : []);
  const currentRequired = new Set(Array.isArray(current.required) ? current.required as string[] : []);
  for (const key of currentRequired) if (!previousRequired.has(key)) changes.push({ kind: "required_added", path: `${path}.required.${key}` });

  const previousProperties = (previous.properties ?? {}) as Record<string, Record<string, unknown>>;
  const currentProperties = (current.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(previousProperties)) {
    if (!(key in currentProperties)) changes.push({ kind: "property_removed", path: `${path}.properties.${key}` });
    else changes.push(...compareSchemas(value, currentProperties[key]!, `${path}.properties.${key}`));
  }

  const previousEnum = Array.isArray(previous.enum) ? previous.enum : undefined;
  const currentEnum = Array.isArray(current.enum) ? current.enum : undefined;
  if (previousEnum !== undefined && (currentEnum === undefined || previousEnum.some((item) => !currentEnum.includes(item)))) changes.push({ kind: "enum_narrowed", path: `${path}.enum` });

  const previousUnion = Array.isArray(previous.anyOf) ? previous.anyOf as Record<string, unknown>[] : undefined;
  const currentUnion = Array.isArray(current.anyOf) ? current.anyOf as Record<string, unknown>[] : undefined;
  if (previousUnion !== undefined) {
    if (currentUnion === undefined) return [...changes, { kind: "union_narrowed", path: `${path}.anyOf` }];
    const branchKey = (item: Record<string, unknown>) => {
      if (typeof item.$id === "string") return `$id:${item.$id}`;
      if (item.const !== undefined) return `const:${JSON.stringify(item.const)}`;
      return `shape:${JSON.stringify(item)}`;
    };
    const before = new Map(previousUnion.map((item) => [branchKey(item), item]));
    const after = new Map(currentUnion.map((item) => [branchKey(item), item]));
    for (const [key, branch] of before) {
      const next = after.get(key);
      if (next === undefined) changes.push({ kind: "union_narrowed", path: `${path}.anyOf.${key}` });
      else changes.push(...compareSchemas(branch, next, `${path}.anyOf.${key}`));
    }
    if ([...after.keys()].some((key) => !before.has(key)) && previous["x-extensible-union"] !== true) changes.push({ kind: "union_growth_not_extensible", path: `${path}.anyOf` });
  }
  return changes;
}
```

CLI 行为：默认逐个比较 `compat/v1/*.schema.json` 与 `schemas/v1/*.schema.json`，任何 `BreakingChange` 退出 1；`--accept-initial-v1` 只在 `compat/v1` 为空时将当前生成文件原样复制为基线，若目录已含 JSON 则拒绝覆盖并退出 1。CLI 入口必须用 `import.meta.url === pathToFileURL(resolve(process.argv[1]!)).href` 守卫后才调用 `main()`，确保 `compatibility.test.ts` 导入 `compareSchemas` 时没有文件 I/O 或 `process.exitCode` 副作用。

- [ ] 生成首次基线并运行所有门禁：

```bash
npm exec -w @core-agent/contracts -- tsx scripts/check-compatibility.ts --accept-initial-v1
npm run fixtures:check -w @core-agent/contracts
npm run compat:check -w @core-agent/contracts
npm run contracts:test
npm run contracts:build
git diff --check
```

Expected: 28 个 baseline 文件；fixture 输出精确计数；兼容检查、测试、构建全部退出码 0。

#### Step 7: 提交生成产物和门禁

- [ ] 提交：

```bash
git add packages/contracts/src packages/contracts/scripts packages/contracts/tests packages/contracts/fixtures packages/contracts/schemas packages/contracts/compat
git commit -m "test(contracts): add schemas fixtures and compatibility gates"
```

**Reviewer Gate:** 审阅者随机删除一个临时 Schema 字段并确认 compat check 红灯，再还原；随机改一个生成文件并确认 schemas check 红灯，再还原；确认 28 个 registry key 都有 valid fixture，非法 fixture 不打印完整敏感 value。

---

### Task 9: 完成安全卫生、README、CI 与全量验收

**Interfaces:**

- Consumes: 完整 contracts workspace、生成门禁、现有 runtime CI。
- Produces: TypeScript/JSON Schema/Python 消费说明、MCP 延后边界、secret 与隐藏字段静态门禁、单一 CI 入口、v1 完成证据。
- Does not produce: Control Plane server、数据库、Web、Apple 客户端、MCP Server 或业务 Tool。

**Files:**

- Create: `packages/contracts/README.md`
- Create: `packages/contracts/CHANGELOG.md`
- Create: `packages/contracts/compatibility-change.json`
- Create: `packages/contracts/tests/security.test.ts`
- Modify: `README.md`
- Modify: `.github/workflows/runtime-contract.yml`

#### Step 1: 写安全卫生红灯测试

- [ ] 创建 `packages/contracts/tests/security.test.ts`：

```ts
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else files.push(path);
  }
  return files.sort();
}

test("fixtures and schemas contain no credential or personal-data patterns", async () => {
  const roots = [resolve(import.meta.dirname, "../fixtures"), resolve(import.meta.dirname, "../schemas")];
  const forbidden = [
    /sk-[A-Za-z0-9_-]{16,}/,
    /Bearer\s+[A-Za-z0-9._-]+/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    /"(?:api_key|access_token|refresh_token|authorization)"\s*:/i,
    /(?:phone|mobile|passport|credit_card|bank_account)\s*[\":=]/i,
  ];
  for (const root of roots) {
    for (const path of await filesBelow(root)) {
      const content = await readFile(path, "utf8");
      for (const pattern of forbidden) assert.equal(pattern.test(content), false, `${path} matched ${pattern}`);
    }
  }
});

test("public schemas do not expose hidden reasoning or raw tool payload fields", async () => {
  const files = await filesBelow(resolve(import.meta.dirname, "../schemas"));
  const forbiddenFields = ["hidden_reasoning", "chain_of_thought", "raw_input", "raw_output", "api_key", "access_token", "stack"];
  for (const path of files) {
    const document = JSON.parse(await readFile(path, "utf8"));
    const serialized = JSON.stringify(document);
    for (const field of forbiddenFields) assert.equal(serialized.includes(`\"${field}\"`), false, `${path} exposes ${field}`);
  }
});
```

- [ ] 暂时向一个本地 fixture 加入 `"access_token": "synthetic"`，运行：

```bash
node --import tsx --test --test-name-pattern="credential or personal-data|hidden reasoning" packages/contracts/tests/*.test.ts
```

Expected: 失败并指出该 fixture；立即删除临时字段，再继续实现。这个临时故障不得提交。

#### Step 2: 编写包级消费文档与版本声明

- [ ] 创建 `packages/contracts/README.md`，必须包含可复制执行的四部分：

1. TypeScript：

```ts
import { TenantSchema, type Tenant } from "@core-agent/contracts";
import Schema from "typebox/schema";

const validator = Schema.Compile(TenantSchema);
export function isTenant(value: unknown): value is Tenant {
  return validator.Check(value);
}
```

2. JSON Schema：说明 Python/OpenAPI/Swift 生成器读取 `@core-agent/contracts/schemas/v1/tenant.schema.json`，不得复制手写字段。
3. Trusted Context：说明 payload/envelope 校验不等于密码学签名验证；服务端消费者还必须验证 issuer、audience、有效期、签名和最新 authority。
4. MCP 延后边界：第一方新 MCP 默认 TypeScript，已有 Python 服务读取生成 Schema；本包没有 MCP SDK、Server 或 Tool 实现。

- [ ] 创建 `packages/contracts/CHANGELOG.md`：

```markdown
# Changelog

## 0.1.0 - 2026-08-03

- Establish wire schema version 1 for identity, runtime, trusted context,
  product events, audit events, errors, idempotency, and external references.
- Add generated JSON Schema, anonymous fixtures, and compatibility checks.
```

- [ ] 创建 `packages/contracts/compatibility-change.json`：

```json
{
  "package_version": "0.1.0",
  "wire_schema_version": 1,
  "change_level": "major",
  "reason": "Initial wire schema version 1 baseline"
}
```

后续每次协议变更必须在同一 PR 更新 changelog 和该声明；`change_level` 只允许 `patch | minor | major`。

#### Step 3: 更新根 README 与 CI

- [ ] 在根 `README.md` 增加 `Control Plane Contracts` 章节，包含：包路径、`npm run contracts:check`、设计规格链接、包 README 链接，以及明确的未实现列表（Control Plane runtime、数据库、Web、Apple、MCP）。不得把 Contracts 完成描述成“完整后台已经完成”。

- [ ] 将 `.github/workflows/runtime-contract.yml` 的 Node setup 后半部分改为：

```yaml
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install pinned dependencies
        run: npm ci

      - name: Run runtime and contracts tests
        run: npm test

      - name: Build and verify contracts
        run: npm run contracts:check

      - name: Validate Compose configuration
        env:
          CORE_AGENT_API_SERVER_KEY: ci-contract-test-only-not-a-secret-0000000000000000
        run: docker compose -f infra/hermes/compose.dev.yaml config --quiet
```

保留现有 checkout、触发条件、最小 permissions 和 Compose 检查。

#### Step 4: 全量验收和负向门禁演练

- [ ] 运行正式验收：

```bash
npm ci
npm test
npm run contracts:check
npm run contracts:schemas
git diff --exit-code -- packages/contracts/schemas packages/contracts/compat
git diff --check
```

Expected:

- `npm test` 同时通过现有 runtime tests 与全部 contracts tests；
- `contracts:check` 依次通过 build、test、schema drift、fixture、compat；
- 重新生成 Schema 后 `git diff --exit-code` 退出 0；
- 无 whitespace error。

- [ ] 做三次不提交的负向演练，每次确认红灯后恢复工作树：

```text
1. 改动 schemas/v1/tenant.schema.json 的一个字符，schemas:check 必须失败。
2. 在当前 Tenant Schema 删除 display_name 后重新生成，compat:check 必须报告 property_removed。
3. 在 invalid fixture 放入 synthetic Bearer credential pattern，security test 必须失败。
```

使用 `git restore` 只恢复本步骤明确修改的文件；不得恢复或覆盖用户的其他变更。

#### Step 5: 检查范围、提交并记录证据

- [ ] 运行：

```bash
git status --short
git diff --stat
git diff --check
```

Expected: 只有本任务文档、CI 和安全测试变更；没有 `.env`、凭据、客户数据、Docker volume 或 Hermes 本地状态。

- [ ] 提交：

```bash
git add README.md .github/workflows/runtime-contract.yml packages/contracts/README.md packages/contracts/CHANGELOG.md packages/contracts/compatibility-change.json packages/contracts/tests/security.test.ts
git commit -m "docs(contracts): document and enforce v1 release gates"
```

**Reviewer Gate:** Reviewer 根据下面的最终矩阵逐项签字；CI 全绿；任何未实现子系统都没有空壳、假接口或完成声明。

---

## 最终验收矩阵

| 规格要求 | 主要实现任务 | 自动证据 |
|---|---:|---|
| TypeScript 类型 + 运行时 Schema | 2-7 | `contracts:build`, 单元测试 |
| 28 个标准 JSON Schema | 8 | `schemas:check`, `schema-generation.test.ts` |
| Tenant/Actor/Membership/Profile | 3 | `identity.test.ts` |
| B2B/B2C 与跨租户不变量 | 3 | `identity.test.ts`, semantic fixtures |
| Container/Conversation/Session/Run/Task/Approval | 4 | `runtime.test.ts` |
| 八类状态机 | 4 | 转换矩阵测试 |
| TrustedRequestContext 与 5 分钟 TTL | 5 | `trusted-request-context.test.ts` |
| ProductEvent unknown fallback | 6-7 | `product-event.test.ts`, `delivery.test.ts` |
| AuditEvent 与 ErrorEnvelope | 6 | `product-event.test.ts` |
| 幂等、重复、乱序、cursor | 7 | `delivery.test.ts` |
| 合法/非法 fixtures | 8 | `fixtures:check` |
| 兼容性基线 | 8 | `compat:check`, `compatibility.test.ts` |
| Secret/隐私卫生 | 9 | `security.test.ts` |
| 不依赖 Docker/DB/网络/MCP | 1-9 | package dependencies + CI isolated tests |
| MCP 仅保留未来接入方案 | 9 | package README + dependency review |

## 计划自身审阅清单

在开始执行 Task 1 前，计划作者和执行者共同完成：

- [ ] 对照设计规格第 2、4-16 节，确认上表每一项都有任务和自动证据；
- [ ] 运行占位词扫描，结果为空：

```bash
blocked_words='TO''DO|TB''D|FIX''ME|待''定|以后''补|类似''实现|占位''实现'
rg -n "$blocked_words" docs/superpowers/plans/2026-08-03-control-plane-contracts-v1.md
```

- [ ] 检查类型命名一致：Schema 使用 `XxxSchema`，静态类型使用 `Xxx`，wire 字段使用 `snake_case`；
- [ ] 检查所有命令都从 `/Users/weiyuan/personal/Core-Agent` 或 workspace 根可执行；
- [ ] 检查每个任务都有红灯、绿灯、`git diff --check`、独立 commit 和 Reviewer Gate；
- [ ] 检查 TypeBox 资源组合使用 `ResourceMetadataFields` 展开，不使用会被 `additionalProperties: false` 冲突的 `allOf`；
- [ ] 检查计划 diff：

```bash
git diff --check
git diff -- docs/superpowers/plans/2026-08-03-control-plane-contracts-v1.md
```

## 执行顺序和停止条件

严格按 Task 1 → 9 执行。每个 Reviewer Gate 是硬停止点。以下任一情况必须暂停并回到规格审阅：

- 需要引入数据库、网络、Docker、Hermes 或 MCP SDK 才能让测试通过；
- 需要更改已批准的身份、Profile、容器或 Trusted Context 安全边界；
- 需要增加真实业务 Tool 输入输出；
- 兼容性检查发现破坏性变更但实现仍试图覆盖 v1 baseline；
- 测试需要真实凭据、客户数据或学生数据。

本计划完成只代表 `Control Plane Contracts v1` 可供后续系统引用。下一份规格应在 Contracts 完成并验收后，从 Identity/Control Plane Runtime 中选择一个垂直切片；Web 和 Apple 客户端继续等待后台 runtime 契约落地。
