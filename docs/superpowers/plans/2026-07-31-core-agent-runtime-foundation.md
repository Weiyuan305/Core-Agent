# Core-Agent Hermes Runtime Distribution Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** 把空的 `Core-Agent` 目录建设成一个可复现、可验证、可升级和可回滚的 Hermes 产品发行版仓库，并启动“一家公司一个容器、两个顾问 Profile”的本地开发骨架。

**Architecture:** 本计划只实现九个子项目中的第一个 `Hermes Distribution`。仓库不复制 Hermes 源码，而是通过按 CPU 架构锁定的官方镜像 digest 构建轻量派生镜像；产品级只读配置烘焙到 `/etc/hermes/config.yaml`，运行数据单独挂载到 `/opt/data`。容器只在宿主机 loopback 暴露带 Bearer Token 的 OpenAI-compatible API；两个顾问 Profile 以无内置 Skill 的窄 Profile 创建。Control Plane、业务 MCP、Composite Memory、Web UI 和自定义 Policy Plugin 均不在本计划内。

**Tech Stack:** Docker / Docker Compose、Hermes Agent `v2026.7.30`、Node.js 22 ESM、Node 内置测试框架、GitHub Actions。

---

## 0. 范围和完成标准

### 本计划包含

- 初始化独立 Git 仓库；
- 固定 Hermes 上游 tag 与 `linux/amd64`、`linux/arm64` digest；
- 构建 `core-agent/hermes-runtime` 派生镜像；
- 烘焙最小 managed config；
- 启动单公司开发容器；
- 创建 `consultant-a`、`consultant-b` 两个无内置 Skill 的 Profile；
- 验证健康检查、API 鉴权、Profile 路由、数据持久化和镜像切换；
- 建立只运行静态契约测试的 CI。

### 本计划明确不包含

- 不 fork 或修改 Hermes 上游源码；
- 不创建 Control Plane；
- 不接入 Supabase、Honcho 或 Composite Memory；
- 不接入 EduApply MCP；
- 不实现 Capability Pack、Entitlement、Human Approval；
- 不开发 Web、macOS 或 iOS 客户端；
- 不把 `eduapply`、`auto-apply` 等领域项目移入 `Core-Agent`；
- 不把 managed scope 当作唯一安全边界。

### 完成标准

1. `npm test` 全部通过；
2. 两种 CPU 架构都能解析到 tag + digest 的不可变基础镜像引用；
3. 派生镜像中存在 `/etc/hermes/config.yaml`，且 Hermes 能读取；
4. Compose 只能绑定到 `127.0.0.1`，未挂载 Docker socket；
5. 未提供 API key 时 Compose 配置失败；
6. `/health` 返回 200，未鉴权 `/v1/models` 被拒绝；
7. `/p/consultant-a/v1/models` 和 `/p/consultant-b/v1/models` 均可鉴权访问；
8. 容器强制重建后 `/opt/data` 中的测试文件仍存在；
9. 通过环境变量切换产品镜像 tag 后可重新启动并恢复健康。

---

## 1. 目标目录结构

本计划完成后的结构：

```text
Core-Agent/
├── .dockerignore
├── .env.runtime.example
├── .github/
│   └── workflows/
│       └── runtime-contract.yml
├── .gitignore
├── AGENTS.md
├── README.md
├── docs/
│   ├── architecture/
│   │   └── 0001-hermes-runtime-distribution.md
│   └── superpowers/
│       └── plans/
│           └── 2026-07-31-core-agent-runtime-foundation.md
├── infra/
│   └── hermes/
│       ├── Dockerfile
│       ├── base-images.lock.json
│       ├── compose.dev.yaml
│       ├── managed/
│       │   └── config.yaml
│       └── tenants/
│           └── company-demo.json
├── package.json
├── scripts/
│   ├── bootstrap-demo-company.mjs
│   ├── build-hermes-image.mjs
│   ├── resolve-hermes-image.mjs
│   └── smoke-runtime.mjs
└── tests/
    └── runtime/
        ├── bootstrap-demo-company.test.mjs
        ├── hermes-image-lock.test.mjs
        └── runtime-contract.test.mjs
```

后续子系统按以下边界扩展，不在本计划中提前创建空壳：

```text
apps/control-plane/
apps/web/
packages/contracts/
packages/policy-plugin/
packages/composite-memory/
packages/capability-gateway/
```

---

### Task 1: 初始化仓库并冻结边界

**Files:**

- Create: `.gitignore`
- Create: `.dockerignore`
- Create: `package.json`
- Create: `AGENTS.md`
- Create: `README.md`
- Create: `docs/architecture/0001-hermes-runtime-distribution.md`

**Step 1: 初始化 Git**

Run:

```bash
cd /Users/weiyuan/personal/Core-Agent
git init -b main
```

Expected: 输出 `Initialized empty Git repository`，当前分支为 `main`。

**Step 2: 创建基础文件**

`.gitignore`:

```gitignore
.DS_Store
.env
.env.*
!.env.runtime.example
node_modules/
coverage/
dist/
*.log
```

`.dockerignore`:

```dockerignore
.git
.github
.env
.env.*
node_modules
coverage
dist
docs
tests
```

`package.json`:

```json
{
  "name": "@core-agent/platform",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "test": "node --test",
    "hermes:image-ref": "node scripts/resolve-hermes-image.mjs",
    "hermes:build": "node scripts/build-hermes-image.mjs",
    "hermes:bootstrap": "node scripts/bootstrap-demo-company.mjs",
    "hermes:smoke": "node scripts/smoke-runtime.mjs"
  }
}
```

`AGENTS.md`:

```markdown
# Core-Agent Repository Rules

## Ownership

This repository owns the central agent platform: Hermes distribution,
Control Plane, trusted context contracts, policy and memory plugins,
Capability/MCP routing, event protocol, audit, and evals.

Domain products such as EduApply, IELTS teaching, housing, and auto-apply
remain separate services. Integrate them through versioned MCP contracts;
do not copy their application code into this repository.

## Architecture constraints

- Keep final orchestration authority in one central agent runtime.
- Prefer Hermes plugins and external services before proposing an upstream core patch.
- Treat Hermes managed scope as configuration management, not as a hard security boundary.
- Enforce tenant identity, entitlement, and write approval outside model-controlled input.
- Keep B2B tenant data isolated by container and persistent volume.
- Keep business truth and durable memory in Supabase; local Hermes state is runtime state.
- Never commit credentials, generated API keys, customer data, or student data.

## Change discipline

- Add a spec and implementation plan before starting a new subsystem.
- Add tests before implementation for executable behavior.
- Pin upstream images and dependencies; do not use `latest`.
- Preserve rollback paths for every image or protocol change.
```

`README.md`:

````markdown
# Core-Agent

Core-Agent is the central orchestration platform for the study-abroad product
family. Hermes Agent supplies the agent runtime; this repository owns the
product distribution and the platform layers around it.

## Repository boundary

Core-Agent contains runtime distribution, Control Plane, trusted identity and
entitlement contracts, memory/policy plugins, Capability/MCP routing, the
product event protocol, audit, and evals.

EduApply, IELTS teaching, housing, and browser execution remain independent
domain services and connect through versioned MCP interfaces.

## Current milestone

The first milestone builds a reproducible Hermes runtime image and a local
single-company container with two consultant Profiles. It intentionally has no
business MCP, custom UI, or production tenant provisioning yet.

## Prerequisites

- Node.js 22+
- Docker with Docker Compose v2

## Runtime commands

```bash
npm test
npm run hermes:image-ref
npm run hermes:build
cp .env.runtime.example .env.runtime
# Set CORE_AGENT_API_SERVER_KEY to: openssl rand -hex 32
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml up -d
npm run hermes:bootstrap
set -a; source .env.runtime; set +a; npm run hermes:smoke
```

The development API binds only to `127.0.0.1:18642`.
````

`docs/architecture/0001-hermes-runtime-distribution.md`:

```markdown
# ADR 0001: Hermes Runtime Distribution Boundary

Status: Accepted

## Context

Core-Agent needs Hermes memory, Profile, Skill, tool, and gateway behavior
without turning the product into a long-lived source fork. It also needs
repeatable company containers and a controlled upgrade/rollback path.

## Decision

Build a thin product image from an official Hermes image pinned by tag and
architecture-specific digest. Store persistent runtime data only under
`/opt/data`. Bake non-secret managed defaults into `/etc/hermes/config.yaml`.
Expose the API server only on the host loopback during development.

The product repository owns distribution and platform extensions. Hermes source
changes are allowed only after a plugin or external-service implementation has
been proven insufficient and the patch is documented in a separate ADR.

## Security boundary

Managed scope prevents ordinary profile configuration from overriding selected
defaults, but malformed managed config is fail-open and filesystem permissions
are its enforcement mechanism. Therefore tenant authorization and capability
checks must later be enforced by the Control Plane, MCP Gateway, container
isolation, and service credentials.

## Consequences

- Upstream upgrades are explicit and testable.
- AMD64 and ARM64 builds use different immutable digests.
- Runtime data survives image changes.
- This phase does not yet provide production multi-tenant authorization.
```

**Step 3: 验证基础仓库**

Run:

```bash
node --version
npm test
git status --short
```

Expected:

- Node 版本为 22 或更高；
- `npm test` 报告 0 tests、无失败；
- 仅显示本 Task 新增文件。

**Step 4: 提交**

```bash
git add .gitignore .dockerignore package.json AGENTS.md README.md docs
git commit -m "chore: initialize core-agent platform repository"
```

---

### Task 2: 锁定 Hermes 基础镜像

**Files:**

- Create: `tests/runtime/hermes-image-lock.test.mjs`
- Create: `infra/hermes/base-images.lock.json`
- Create: `scripts/resolve-hermes-image.mjs`

**Step 1: 先写失败测试**

`tests/runtime/hermes-image-lock.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  hostToImagePlatform,
  resolveHermesImage,
  validateImageLock
} from "../../scripts/resolve-hermes-image.mjs";

const lockUrl = new URL("../../infra/hermes/base-images.lock.json", import.meta.url);
const lock = JSON.parse(await readFile(lockUrl, "utf8"));

test("image lock contains valid immutable references", () => {
  assert.doesNotThrow(() => validateImageLock(lock));
  assert.equal(lock.tag, "v2026.7.30");
  assert.match(resolveHermesImage(lock, "linux/amd64"), /@sha256:[a-f0-9]{64}$/);
  assert.match(resolveHermesImage(lock, "linux/arm64"), /@sha256:[a-f0-9]{64}$/);
});

test("host architecture maps to the matching Linux image", () => {
  assert.equal(hostToImagePlatform("darwin", "arm64"), "linux/arm64");
  assert.equal(hostToImagePlatform("linux", "x64"), "linux/amd64");
  assert.throws(
    () => hostToImagePlatform("linux", "riscv64"),
    /Unsupported host architecture/
  );
});

test("resolver rejects unknown platforms", () => {
  assert.throws(
    () => resolveHermesImage(lock, "linux/s390x"),
    /No locked Hermes image/
  );
});
```

Run:

```bash
node --test tests/runtime/hermes-image-lock.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND`，因为 resolver 尚未实现。

**Step 2: 创建镜像锁文件**

`infra/hermes/base-images.lock.json`:

```json
{
  "schemaVersion": 1,
  "repository": "nousresearch/hermes-agent",
  "tag": "v2026.7.30",
  "platforms": {
    "linux/amd64": {
      "reference": "nousresearch/hermes-agent:v2026.7.30@sha256:5316c2c2534c49f5e1b1691e1a2115f1230d900033c3b35d1c8fc2e47352b26d"
    },
    "linux/arm64": {
      "reference": "nousresearch/hermes-agent:v2026.7.30@sha256:f3b812738ebc6113410c54ba5e6c48c56f5b379f00e1aab31c21733aa7842e38"
    }
  }
}
```

**Step 3: 实现 resolver**

`scripts/resolve-hermes-image.mjs`:

```javascript
#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export function hostToImagePlatform(_hostPlatform, hostArchitecture) {
  if (hostArchitecture === "x64") return "linux/amd64";
  if (hostArchitecture === "arm64") return "linux/arm64";
  throw new Error(`Unsupported host architecture: ${hostArchitecture}`);
}

export function validateImageLock(lock) {
  if (lock?.schemaVersion !== 1) {
    throw new Error("Unsupported Hermes image lock schema");
  }
  if (!lock.repository || !lock.tag || !lock.platforms) {
    throw new Error("Hermes image lock is missing required fields");
  }

  for (const platform of ["linux/amd64", "linux/arm64"]) {
    const reference = lock.platforms[platform]?.reference;
    const expectedPrefix = `${lock.repository}:${lock.tag}@`;
    if (!reference?.startsWith(expectedPrefix)) {
      throw new Error(`Invalid Hermes image reference for ${platform}`);
    }
    const digest = reference.slice(expectedPrefix.length);
    if (!digestPattern.test(digest)) {
      throw new Error(`Invalid Hermes image digest for ${platform}`);
    }
  }
}

export function resolveHermesImage(lock, platform) {
  validateImageLock(lock);
  const reference = lock.platforms[platform]?.reference;
  if (!reference) {
    throw new Error(`No locked Hermes image for ${platform}`);
  }
  return reference;
}

async function main() {
  const lockUrl = new URL("../infra/hermes/base-images.lock.json", import.meta.url);
  const lock = JSON.parse(await readFile(lockUrl, "utf8"));
  const platformIndex = process.argv.indexOf("--platform");
  const platform = platformIndex === -1
    ? hostToImagePlatform(process.platform, process.arch)
    : process.argv[platformIndex + 1];

  if (!platform) {
    throw new Error("--platform requires a value");
  }

  process.stdout.write(`${resolveHermesImage(lock, platform)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
```

**Step 4: 运行测试和手工解析**

```bash
node --test tests/runtime/hermes-image-lock.test.mjs
node scripts/resolve-hermes-image.mjs --platform linux/amd64
node scripts/resolve-hermes-image.mjs --platform linux/arm64
```

Expected:

- 3 个测试通过；
- 两条输出分别包含对应的 `v2026.7.30@sha256:...`。

**Step 5: 提交**

```bash
git add infra/hermes/base-images.lock.json scripts/resolve-hermes-image.mjs tests/runtime/hermes-image-lock.test.mjs
git commit -m "build: pin hermes runtime images by architecture"
```

---

### Task 3: 构建产品派生镜像并烘焙 managed config

**Files:**

- Create: `tests/runtime/runtime-contract.test.mjs`
- Create: `infra/hermes/Dockerfile`
- Create: `infra/hermes/managed/config.yaml`
- Create: `scripts/build-hermes-image.mjs`

**Step 1: 先添加镜像契约失败测试**

`tests/runtime/runtime-contract.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildDockerArgs } from "../../scripts/build-hermes-image.mjs";

const dockerfile = await readFile(
  new URL("../../infra/hermes/Dockerfile", import.meta.url),
  "utf8"
);
const managedConfig = await readFile(
  new URL("../../infra/hermes/managed/config.yaml", import.meta.url),
  "utf8"
);

test("Dockerfile requires an externally resolved immutable base image", () => {
  assert.match(dockerfile, /^ARG HERMES_BASE_IMAGE$/m);
  assert.match(dockerfile, /^FROM \$\{HERMES_BASE_IMAGE\}$/m);
  assert.doesNotMatch(dockerfile, /FROM\s+nousresearch\/hermes-agent:latest/);
  assert.match(dockerfile, /COPY infra\/hermes\/managed\/config\.yaml \/etc\/hermes\/config\.yaml/);
});

test("managed config starts with a deliberately narrow tool surface", () => {
  assert.match(managedConfig, /multiplex_profiles:\s+true/);
  assert.match(managedConfig, /api_server:\s*\n\s+- clarify/);
  assert.match(managedConfig, /redact_secrets:\s+true/);
  assert.equal(
    managedConfig.match(/write_approval:\s+true/g)?.length,
    2
  );
  assert.doesNotMatch(managedConfig, /terminal|file|browser|code_execution/);
});

test("build command includes the resolved base reference and product tag", () => {
  const args = buildDockerArgs({
    baseImage: "nousresearch/hermes-agent:v1@sha256:abc",
    platform: "linux/arm64",
    productTag: "core-agent/hermes-runtime:test"
  });

  assert.deepEqual(args.slice(0, 6), [
    "build",
    "--platform",
    "linux/arm64",
    "--build-arg",
    "HERMES_BASE_IMAGE=nousresearch/hermes-agent:v1@sha256:abc",
    "--tag"
  ]);
  assert.equal(args[6], "core-agent/hermes-runtime:test");
});
```

Run:

```bash
node --test tests/runtime/runtime-contract.test.mjs
```

Expected: 失败，因为三个实现文件尚不存在。

**Step 2: 创建 Dockerfile**

`infra/hermes/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

ARG HERMES_BASE_IMAGE
FROM ${HERMES_BASE_IMAGE}

LABEL org.opencontainers.image.title="Core-Agent Hermes Runtime"
LABEL org.opencontainers.image.description="Pinned Hermes runtime distribution for Core-Agent"
LABEL org.opencontainers.image.vendor="Core-Agent"

USER root

COPY infra/hermes/managed/config.yaml /etc/hermes/config.yaml

RUN chmod 0755 /etc/hermes \
    && chmod 0644 /etc/hermes/config.yaml
```

不要在结尾切换到 `USER hermes`：Hermes 官方容器需要 root 启动 s6，然后由其 shim 将 Hermes 服务降权到内部 `hermes` 用户。

**Step 3: 创建最小 managed config**

`infra/hermes/managed/config.yaml`:

```yaml
gateway:
  multiplex_profiles: true

platform_toolsets:
  api_server:
    - clarify
  cli:
    - clarify

plugins:
  enabled: []

security:
  redact_secrets: true

skills:
  write_approval: true

memory:
  write_approval: true
```

这里的窄工具面只用于运行时骨架。后续 Capability/MCP Gateway 完成后，再通过独立 Policy Plugin 和 Capability manifest 为请求动态开放工具，不能在本计划里先开放 `terminal`、`file` 或 `browser`。

**Step 4: 实现构建脚本**

`scripts/build-hermes-image.mjs`:

```javascript
#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  hostToImagePlatform,
  resolveHermesImage
} from "./resolve-hermes-image.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export function buildDockerArgs({ baseImage, platform, productTag }) {
  return [
    "build",
    "--platform",
    platform,
    "--build-arg",
    `HERMES_BASE_IMAGE=${baseImage}`,
    "--tag",
    productTag,
    "--file",
    "infra/hermes/Dockerfile",
    "."
  ];
}

function flagValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

async function main() {
  const lockUrl = new URL("../infra/hermes/base-images.lock.json", import.meta.url);
  const lock = JSON.parse(await readFile(lockUrl, "utf8"));
  const platform = flagValue(
    "--platform",
    hostToImagePlatform(process.platform, process.arch)
  );
  const productTag = flagValue(
    "--tag",
    "core-agent/hermes-runtime:dev"
  );
  const baseImage = resolveHermesImage(lock, platform);
  const result = spawnSync(
    "docker",
    buildDockerArgs({ baseImage, platform, productTag }),
    { cwd: repositoryRoot, stdio: "inherit" }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker build failed with exit code ${result.status}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
```

**Step 5: 测试并构建**

```bash
npm test
npm run hermes:build
docker image inspect core-agent/hermes-runtime:dev --format '{{json .RepoTags}}'
docker run --rm core-agent/hermes-runtime:dev hermes --version
docker run --rm core-agent/hermes-runtime:dev sh -lc 'test -r /etc/hermes/config.yaml'
```

Expected:

- 所有单元测试通过；
- 构建使用当前主机架构对应的 digest；
- 镜像 tag 包含 `core-agent/hermes-runtime:dev`；
- `hermes --version` 成功；
- managed config 可读。

**Step 6: 提交**

```bash
git add infra/hermes/Dockerfile infra/hermes/managed/config.yaml scripts/build-hermes-image.mjs tests/runtime/runtime-contract.test.mjs
git commit -m "build: create managed hermes product image"
```

---

### Task 4: 建立单公司开发容器

**Files:**

- Create: `.env.runtime.example`
- Create: `infra/hermes/compose.dev.yaml`
- Modify: `tests/runtime/runtime-contract.test.mjs`

**Step 1: 先扩展失败测试**

在 `tests/runtime/runtime-contract.test.mjs` 末尾增加：

```javascript
const composeConfig = await readFile(
  new URL("../../infra/hermes/compose.dev.yaml", import.meta.url),
  "utf8"
);

test("development runtime is private and keeps state outside the image", () => {
  assert.match(composeConfig, /127\.0\.0\.1:\$\{CORE_AGENT_API_SERVER_PORT:-18642\}:8642/);
  assert.match(composeConfig, /company-demo-hermes-data:\/opt\/data/);
  assert.match(composeConfig, /read_only:\s+true/);
  assert.match(composeConfig, /no-new-privileges:true/);
  assert.match(composeConfig, /cap_drop:\s*\n\s+- ALL/);
  assert.doesNotMatch(composeConfig, /docker\.sock/);
});

test("API server cannot start without an explicit key", () => {
  assert.match(
    composeConfig,
    /CORE_AGENT_API_SERVER_KEY:\?set CORE_AGENT_API_SERVER_KEY/
  );
});
```

Run:

```bash
node --test tests/runtime/runtime-contract.test.mjs
```

Expected: 因为 Compose 文件尚不存在而失败。

**Step 2: 创建环境变量模板**

`.env.runtime.example`:

```dotenv
CORE_AGENT_HERMES_IMAGE=core-agent/hermes-runtime:dev
CORE_AGENT_API_SERVER_PORT=18642
CORE_AGENT_API_SERVER_KEY=
```

`CORE_AGENT_API_SERVER_KEY` 必须由操作者生成，不能在模板中放一个看似可用的共享 key。

**Step 3: 创建 Compose 文件**

`infra/hermes/compose.dev.yaml`:

```yaml
name: core-agent-company-demo

services:
  hermes:
    image: ${CORE_AGENT_HERMES_IMAGE:-core-agent/hermes-runtime:dev}
    command:
      - gateway
      - run
    environment:
      API_SERVER_ENABLED: "true"
      API_SERVER_HOST: "0.0.0.0"
      API_SERVER_PORT: "8642"
      API_SERVER_KEY: ${CORE_AGENT_API_SERVER_KEY:?set CORE_AGENT_API_SERVER_KEY}
      GATEWAY_MULTIPLEX_PROFILES: "true"
    ports:
      - "127.0.0.1:${CORE_AGENT_API_SERVER_PORT:-18642}:8642"
    volumes:
      - company-demo-hermes-data:/opt/data
    read_only: true
    tmpfs:
      - /run:size=64m,mode=0755
      - /tmp:size=256m,mode=1777
      - /var/tmp:size=64m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 512
    mem_limit: 4g
    cpus: 2.0
    restart: unless-stopped
    stop_grace_period: 45s
    healthcheck:
      test:
        - CMD-SHELL
        - curl --fail --silent http://127.0.0.1:8642/health >/dev/null || exit 1
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s
    networks:
      - core-agent-backplane

volumes:
  company-demo-hermes-data:
    name: core-agent-company-demo-hermes-data

networks:
  core-agent-backplane:
    name: core-agent-company-demo-backplane
    driver: bridge
```

开发网络保留正常出站能力，便于后续调用模型；生产环境的 Egress Gateway 和域名 allowlist 属于 Control Plane/部署计划，不在这里伪造。

**Step 4: 验证 Compose 静态契约**

```bash
cp .env.runtime.example .env.runtime
API_KEY="$(openssl rand -hex 32)"
sed -i.bak "s/^CORE_AGENT_API_SERVER_KEY=.*/CORE_AGENT_API_SERVER_KEY=${API_KEY}/" .env.runtime
rm .env.runtime.bak
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml config --quiet
npm test
```

Expected:

- Compose 配置验证通过；
- `.env.runtime` 被 `.gitignore` 忽略；
- 所有测试通过。

再验证缺少 key 会 fail closed：

```bash
docker compose --env-file .env.runtime.example -f infra/hermes/compose.dev.yaml config
```

Expected: 非零退出，错误包含 `set CORE_AGENT_API_SERVER_KEY`。

**Step 5: 首次启动并处理只读 RootFS 兼容性**

```bash
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml up -d
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml ps
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml logs --tail=200 hermes
```

Expected: `hermes` 最终显示 `healthy`。

如果日志明确显示 s6 需要写入另一个系统路径，只允许把该精确路径增加为 `tmpfs`；不要移除 `read_only: true`。修改后必须增加对应契约断言并重新运行测试。

**Step 6: 提交**

```bash
git add .env.runtime.example infra/hermes/compose.dev.yaml tests/runtime/runtime-contract.test.mjs
git commit -m "feat: add isolated single-company hermes runtime"
```

---

### Task 5: 以声明式 fixture 创建顾问 Profile

**Files:**

- Create: `infra/hermes/tenants/company-demo.json`
- Create: `tests/runtime/bootstrap-demo-company.test.mjs`
- Create: `scripts/bootstrap-demo-company.mjs`

**Step 1: 先写失败测试**

`tests/runtime/bootstrap-demo-company.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildProfileOperations,
  validateCompanyFixture
} from "../../scripts/bootstrap-demo-company.mjs";

const fixtureUrl = new URL(
  "../../infra/hermes/tenants/company-demo.json",
  import.meta.url
);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));

test("company fixture contains two safe consultant profiles", () => {
  assert.doesNotThrow(() => validateCompanyFixture(fixture));
  assert.equal(fixture.tenantId, "company-demo");
  assert.deepEqual(
    fixture.profiles.map((profile) => profile.name),
    ["consultant-a", "consultant-b"]
  );
});

test("bootstrap operations always opt out of bundled skills", () => {
  const operations = buildProfileOperations(fixture);
  assert.deepEqual(operations.defaultProfile, [
    "skills",
    "opt-out",
    "--remove",
    "--yes"
  ]);
  for (const profile of operations.profiles) {
    assert.ok(profile.create.includes("--no-skills"));
    assert.ok(profile.create.includes("--no-alias"));
    assert.equal(profile.create[0], "profile");
    assert.equal(profile.show[0], "profile");
  }
});

test("unsafe profile names are rejected before invoking Docker", () => {
  const unsafe = structuredClone(fixture);
  unsafe.profiles[0].name = "../escape";
  assert.throws(() => validateCompanyFixture(unsafe), /Invalid profile name/);
});
```

Run:

```bash
node --test tests/runtime/bootstrap-demo-company.test.mjs
```

Expected: 失败，因为 fixture 和 bootstrap 脚本尚不存在。

**Step 2: 创建公司 fixture**

`infra/hermes/tenants/company-demo.json`:

```json
{
  "schemaVersion": 1,
  "tenantId": "company-demo",
  "profiles": [
    {
      "name": "consultant-a",
      "description": "Study-abroad consultant profile for the company-demo tenant."
    },
    {
      "name": "consultant-b",
      "description": "Study-abroad consultant profile for the company-demo tenant."
    }
  ]
}
```

这个文件只是本地开发 fixture，不是未来 Control Plane 的租户数据库。

**Step 3: 实现幂等 bootstrap**

`scripts/bootstrap-demo-company.mjs`:

```javascript
#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const composeFile = "infra/hermes/compose.dev.yaml";
const runtimeEnvFile = ".env.runtime";
const profileNamePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function validateCompanyFixture(fixture) {
  if (fixture?.schemaVersion !== 1 || !fixture.tenantId) {
    throw new Error("Invalid company fixture header");
  }
  if (!Array.isArray(fixture.profiles) || fixture.profiles.length === 0) {
    throw new Error("Company fixture must contain profiles");
  }

  const names = new Set();
  for (const profile of fixture.profiles) {
    if (!profileNamePattern.test(profile.name ?? "")) {
      throw new Error(`Invalid profile name: ${profile.name}`);
    }
    if (names.has(profile.name)) {
      throw new Error(`Duplicate profile name: ${profile.name}`);
    }
    if (!profile.description?.trim()) {
      throw new Error(`Missing profile description: ${profile.name}`);
    }
    names.add(profile.name);
  }
}

export function buildProfileOperations(fixture) {
  validateCompanyFixture(fixture);
  return {
    defaultProfile: ["skills", "opt-out", "--remove", "--yes"],
    profiles: fixture.profiles.map((profile) => ({
      name: profile.name,
      show: ["profile", "show", profile.name],
      create: [
        "profile",
        "create",
        profile.name,
        "--no-skills",
        "--no-alias",
        "--description",
        profile.description
      ],
      describe: [
        "profile",
        "describe",
        profile.name,
        "--text",
        profile.description
      ]
    }))
  };
}

function runHermes(arguments_, { allowFailure = false, quiet = false } = {}) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      runtimeEnvFile,
      "-f",
      composeFile,
      "exec",
      "-T",
      "hermes",
      "hermes",
      ...arguments_
    ],
    {
      cwd: repositoryRoot,
      stdio: quiet ? "ignore" : "inherit"
    }
  );

  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `Hermes command failed (${result.status}): hermes ${arguments_.join(" ")}`
    );
  }
  return result.status ?? 1;
}

async function main() {
  const fixtureUrl = new URL(
    "../infra/hermes/tenants/company-demo.json",
    import.meta.url
  );
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const operations = buildProfileOperations(fixture);

  runHermes(operations.defaultProfile);

  for (const profile of operations.profiles) {
    const exists = runHermes(profile.show, {
      allowFailure: true,
      quiet: true
    }) === 0;

    if (exists) {
      runHermes(profile.describe);
    } else {
      runHermes(profile.create);
    }
  }

  runHermes(["profile", "list"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
```

**Step 4: 测试并运行两次证明幂等**

```bash
npm test
npm run hermes:bootstrap
npm run hermes:bootstrap
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml exec -T hermes hermes profile list
```

Expected:

- 单元测试通过；
- 两次 bootstrap 均为 0；
- Profile 列表包含 `default`、`consultant-a`、`consultant-b`；
- 第二次不会报告 Profile 已存在错误。

**Step 5: 提交**

```bash
git add infra/hermes/tenants/company-demo.json scripts/bootstrap-demo-company.mjs tests/runtime/bootstrap-demo-company.test.mjs
git commit -m "feat: bootstrap demo company consultant profiles"
```

---

### Task 6: 添加运行时烟雾测试

**Files:**

- Create: `scripts/smoke-runtime.mjs`
- Modify: `README.md`

**Step 1: 创建烟雾测试**

`scripts/smoke-runtime.mjs`:

```javascript
#!/usr/bin/env node

const port = process.env.CORE_AGENT_API_SERVER_PORT ?? "18642";
const apiKey = process.env.CORE_AGENT_API_SERVER_KEY;
const baseUrl = `http://127.0.0.1:${port}`;

if (!apiKey) {
  process.stderr.write(
    "CORE_AGENT_API_SERVER_KEY is required; load .env.runtime before running smoke tests\n"
  );
  process.exit(1);
}

async function request(path, { authenticated = true } = {}) {
  const headers = authenticated
    ? { authorization: `Bearer ${apiKey}` }
    : {};
  return fetch(`${baseUrl}${path}`, { headers });
}

async function expectStatus(path, expectedStatuses, options) {
  const allowedStatuses = Array.isArray(expectedStatuses)
    ? expectedStatuses
    : [expectedStatuses];
  const response = await request(path, options);
  if (!allowedStatuses.includes(response.status)) {
    const body = await response.text();
    throw new Error(
      `${path}: expected ${allowedStatuses.join(" or ")}, received ${response.status}: ${body}`
    );
  }
  return response;
}

await expectStatus("/health", 200, { authenticated: false });
await expectStatus("/v1/models", [401, 403], { authenticated: false });
await expectStatus("/v1/models", 200);

for (const profile of ["consultant-a", "consultant-b"]) {
  const response = await expectStatus(`/p/${profile}/v1/models`, 200);
  const payload = await response.json();
  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    throw new Error(`${profile}: /v1/models returned no models`);
  }
}

process.stdout.write("Core-Agent Hermes runtime smoke test passed\n");
```

**Step 2: 执行 API 契约测试**

```bash
set -a
source .env.runtime
set +a
npm run hermes:smoke
```

Expected:

```text
Core-Agent Hermes runtime smoke test passed
```

未鉴权请求只接受 401 或 403，绝不能接受 200。

**Step 3: 验证持久化**

```bash
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml exec -T hermes sh -lc 'mkdir -p /opt/data/core-agent-smoke && printf persisted >/opt/data/core-agent-smoke/persistence.txt'
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml up -d --force-recreate
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml exec -T hermes sh -lc 'test "$(cat /opt/data/core-agent-smoke/persistence.txt)" = persisted'
```

Expected: 三条命令均为 0，证明数据不在镜像层。

**Step 4: 验证镜像切换/回滚入口**

```bash
docker tag core-agent/hermes-runtime:dev core-agent/hermes-runtime:rollback-smoke
CORE_AGENT_HERMES_IMAGE=core-agent/hermes-runtime:rollback-smoke docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml up -d --force-recreate
npm run hermes:smoke
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml up -d --force-recreate
npm run hermes:smoke
```

Expected: 使用临时 tag 和切回 `.env.runtime` 中的默认 tag 后均健康。真正的上游升级计划必须使用两个不同 digest 再执行同一流程。

**Step 5: 在 README 增加停止方式**

在 `README.md` 的 runtime commands 后增加：

````markdown
## Stop the development runtime

```bash
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml down
```

This preserves the named volume. Add `--volumes` only when intentionally
destroying all demo-company runtime data.
````

**Step 6: 验证并提交**

```bash
npm test
git diff --check
git add scripts/smoke-runtime.mjs README.md
git commit -m "test: verify hermes runtime routing and persistence"
```

---

### Task 7: 添加 CI 和最终验收

**Files:**

- Create: `.github/workflows/runtime-contract.yml`

**Step 1: 创建 CI**

`.github/workflows/runtime-contract.yml`:

```yaml
name: Runtime Contract

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  contract:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Run contract tests
        run: npm test

      - name: Validate Compose configuration
        env:
          CORE_AGENT_API_SERVER_KEY: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
        run: docker compose -f infra/hermes/compose.dev.yaml config --quiet
```

CI 不拉取巨大的 Hermes 镜像，也不需要模型密钥；实际镜像构建和运行 smoke 由本地/发布流水线执行。后续创建镜像发布计划时，再增加带缓存的多架构 build、签名和 SBOM。

**Step 2: 执行完整本地验收**

```bash
npm test
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml config --quiet
npm run hermes:build
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml up -d
npm run hermes:bootstrap
set -a
source .env.runtime
set +a
npm run hermes:smoke
git diff --check
git status --short --branch
```

Expected:

- 所有测试通过；
- Compose 校验通过；
- 镜像构建成功；
- 容器健康；
- 两个 Profile 可路由；
- smoke 通过；
- `git diff --check` 无输出；
- 只剩预期未提交的 CI 文件。

**Step 3: 审查实际安全属性**

```bash
docker inspect core-agent-company-demo-hermes-1 --format '{{json .HostConfig.ReadonlyRootfs}}'
docker inspect core-agent-company-demo-hermes-1 --format '{{json .HostConfig.CapDrop}}'
docker inspect core-agent-company-demo-hermes-1 --format '{{json .HostConfig.SecurityOpt}}'
docker port core-agent-company-demo-hermes-1
```

Expected:

- `ReadonlyRootfs` 为 `true`；
- `CapDrop` 包含 `ALL`；
- `SecurityOpt` 包含 `no-new-privileges:true`；
- 端口只显示 `127.0.0.1:18642`。

**Step 4: 提交**

```bash
git add .github/workflows/runtime-contract.yml
git commit -m "ci: validate hermes runtime distribution contracts"
```

**Step 5: 最终历史检查**

```bash
git log --oneline --decorate -7
git status --short --branch
```

Expected: 7 个小而清晰的提交，工作区干净。

---

## 2. 后续计划顺序

本计划验收后，依次创建新的独立 Spec 和 Implementation Plan：

1. `Control Plane Contracts`：Tenant、Profile、Container、Request Context、事件和审计 schema；
2. `Control Plane Runtime`：容器生命周期、Profile 路由、API key 管理、镜像升级/回滚；
3. `Identity and Entitlement`：B2B 席位、角色、Capability Pack 购买与可信签名上下文；
4. `Core-Agent Policy Plugin`：验证签名上下文、动态工具可见性、pre-tool fail-closed；
5. `Composite Memory v1`：Supabase 权威数据 + Honcho projection + ACL/Consent；
6. `EduApply Read-only MCP`：第一个端到端业务切片；
7. `Web Event Protocol and UI`；
8. `Write Operations and Human Approval`。

第一个后续计划应是 `Control Plane Contracts`，而不是直接写 Web UI 或把 EduApply 代码搬进来。

---

## 3. 自审记录

- **规格覆盖：**覆盖总体架构 Phase 0 中 Hermes 产品镜像、单公司容器、2 个 Profile、升级/回滚基础；
- **边界：**没有提前实现 Control Plane、Memory、MCP 或 UI；
- **上游兼容：**只使用稳定 Docker 发行版已有的 `gateway run`、API Server、Profile 和 managed scope；
- **安全：**API key 缺失时 fail closed；loopback 绑定；只读 RootFS；无 Docker socket；工具面默认收窄；
- **重要限制：**managed config 仍不是硬安全边界，后续必须由 Control Plane、MCP Gateway 和容器隔离执行权限；
- **可测试性：**静态契约测试不需要网络；真实 Docker smoke 单独执行；
- **无占位实现：**所有代码变更步骤给出完整内容；未来子系统没有创建虚假空壳。
