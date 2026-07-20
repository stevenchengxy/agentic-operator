# Agent Factory 独立 sandbox VM 部署

这套文件把可晋升的测试执行面放到一台独立 Linux VM/node。它与仓库根目录的同宿主 Compose profile 是两套拓扑：根目录 profile 只能诊断，不能产生 promotion 证据；这里的 runner 在启动前会验证远端 machine-id、主机 machine-id 不相同，并把执行层固定为 `remote_vm`。

## 文件与边界

- `compose.external.yml`：独立 stack，只包含 control runner、workload、broker gateway、durable Inngest、PostgreSQL 和 Redis。它不引用主 stack 的 `api` 服务、network 或 volume，也不发布任何宿主机端口。
- `compose.external-loopback.yml`：显式 ingress overlay，只允许把 control 的 `3560` 绑定到 `127.0.0.1`。宿主现有的 TLS 反代或 VPN ingress 再代理到这个 loopback 地址。
- `compose.primary-external-connection.yml`：只在主系统宿主上使用，为 API 配置 exact runner URL/key/build/workload digest allowlist，并补充独立 receipt HMAC 文件挂载。它不加入远端 Docker network。
- `init-secrets.mjs`：只创建缺失的密钥文件，绝不覆盖已有的 durable HMAC，也不打印密钥值。
- `validate-external-sandbox.mjs`：检查 host identity、HTTPS、镜像 digest、secret 权限/分权、候选镜像 allowlist、Docker socket、已预载的 RepoDigest，并以 `docker compose config --quiet` 验证最终配置；不会启动服务。

远端 workload 是唯一持有 Docker socket 的长期进程。它只在这台独立 VM 上创建一次性 candidate；candidate 本身继续使用 `network=none`、只读 rootfs、空 env、零 mount。主 API、control、gateway、broker 和 candidate 都不持有这个 socket。

## 代码无法替你猜的四类输入

开始部署前必须由人或基础设施系统提供：

1. 一台真正独立的 Linux VM/node，以及远端和主系统两个不同的稳定 host identity。代码不能从本地仓库发现另一台机器，也不能代替云平台证明它不是主宿主。
2. runner 的 HTTPS 域名、可信证书和现有 TLS 反代/VPN ingress。仓库没有替你签发公网证书；没有 TLS 时 control 保持只绑定 loopback，主 API 会连接失败而不是降级成明文公网。
3. registry 中经过发布/扫描/签名的 immutable image refs：control、workload、gateway、candidate、Inngest、PostgreSQL、Redis。tag 和零 digest 都会被拒绝。
4. secret manager/安全传输方式，以及主 API 对外提供的 HTTPS model-proxy origin。四个 shared secret 必须安全复制到主控制面；其余 broker/delete/database secret 不得离开远端 VM。

缺任何一项时都应停在 `ask_user`，不能把 example 值或同宿主容器当成已部署环境。

## 1. 准备远端主机身份与密钥

先在远端 VM 上复制 `deploy/factory-sandbox/` 与 `deploy/compose/inngest-start.sh`，安装 Docker Engine + Compose v2，并创建一个专用、非 root 的 secret-reader group。示例中的 `1999` 只是 GID 示例，必须换成远端实际创建的专用组：

```sh
node deploy/factory-sandbox/validate-external-sandbox.mjs \
  --print-host-id --host-id-file /etc/machine-id

sudo node deploy/factory-sandbox/init-secrets.mjs \
  --secret-root /secure/agentic-factory-sandbox \
  --secret-gid 1999
```

`EXTERNAL_SANDBOX_EXPECTED_HOST_ID_SHA256` 使用上面输出。`EXTERNAL_SANDBOX_PRIMARY_HOST_ID_SHA256` 必须来自主系统的独立资产清单/稳定 machine identity，并且不同于远端值。runner 容器启动时会重新计算远端值；仅修改 `SANDBOX_RUNNER_ACTUAL_ISOLATION_TIER` 无法绕过这个检查。

密钥目录使用 `0750`，文件使用 `0640`，group 为 `EXTERNAL_SANDBOX_SECRET_GID`；所有需要读 secret 的容器只补充这个 numeric group。Docker socket 使用另一个 `EXTERNAL_SANDBOX_DOCKER_SOCKET_GID`，两种能力不能复用同一组。

## 2. 填写 metadata-only env

复制 `.env.external.example` 到仓库外的安全运维目录，填写真实值。这个 env 文件只放 URL、id、digest 和宿主文件路径，不放 secret value。

重要约束：

- `EXTERNAL_SANDBOX_PUBLIC_RUNNER_ORIGIN` 与 `EXTERNAL_SANDBOX_MODEL_PROXY_ORIGIN` 都必须是无 path、无内嵌凭证的 HTTPS origin。
- model proxy 必须是主 API 的真实网络地址，不能写 `api`、`host.docker.internal` 或其他主 Compose DNS 名。
- `EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST` 必须等于 `EXTERNAL_SANDBOX_WORKLOAD_IMAGE` 的 `@sha256:` suffix。validator 还会确认每个镜像已在远端 Docker daemon 中以完全相同的 RepoDigest 预载；receipt 不能自报另一个 digest。
- `EXTERNAL_SANDBOX_CANDIDATE_IMAGE_ALLOWLIST` 只能包含一个值，而且必须精确等于 pinned candidate ref。
- `EXTERNAL_SANDBOX_IMAGE_PULL_POLICY=never`。先通过受控发布流程预载 exact digests，再验证/启动，运行时不解析 mutable tag。

## 3. TLS ingress 与 egress

仓库没有自动签发证书，也不会把 3560 暴露到 `0.0.0.0`。在远端宿主已有的 Nginx/Envoy/Caddy、云负载均衡或 VPN ingress 中：

- 只接受 `EXTERNAL_SANDBOX_PUBLIC_RUNNER_ORIGIN` 的有效 TLS；
- 最好同时限制主 API 的固定源地址或启用 mTLS/VPN；
- upstream 只能是 `http://127.0.0.1:${EXTERNAL_SANDBOX_CONTROL_LOOPBACK_PORT}`；
- 不要把 workload、gateway、raw Inngest、PostgreSQL 或 Redis 端口转发到宿主。

workload 是唯一加入非 internal egress bridge 的 sandbox 服务。平台防火墙/VPC policy 必须 default-deny，只允许 DNS 到受信 resolver，以及到 `EXTERNAL_SANDBOX_MODEL_PROXY_ORIGIN:443` 的连接。应用还会精确锁定 HTTPS origin，但应用 allowlist 不能替代宿主网络策略。没有这条平台策略时，环境尚不具备可晋升资格。

## 4. 预载并验证，不启动

先用发布系统把 env 中的七个 exact `repository@sha256` 镜像 pull/load 到远端 daemon。然后运行：

```sh
pnpm validate:factory-external-sandbox -- \
  --env-file /secure/config/agentic-factory-sandbox.env
```

验证顺序是：配置与 placeholder → machine-id → secret 分权/权限 → workload digest 绑定 → Docker socket → 本地 RepoDigests → 两个 Compose 文件的 `config --quiet`。Compose stdout/stderr 被抑制，失败时不会把展开配置写到日志。

只有验证通过后才启动：

```sh
docker compose \
  --env-file /secure/config/agentic-factory-sandbox.env \
  -f deploy/factory-sandbox/compose.external.yml \
  -f deploy/factory-sandbox/compose.external-loopback.yml \
  up -d
```

不要使用 `down --volumes` 处理普通升级。control nonce/job journal、workload 数据、gateway tombstone、PostgreSQL 和 Redis 都是 durable volume；删除 volume 是显式销毁测试执行面及其恢复证据。

## 5. 把精确连接配置交给主 API

远端初始化后，只允许通过 secret manager/加密传输把以下四个文件复制到主系统的 secret store：

| 远端文件 | 主 API 用途 |
| --- | --- |
| `shared-with-primary/request-hmac` | 签名 job request 与防重放 |
| `shared-with-primary/result-hmac` | 验证 status/result 与 durable journal |
| `shared-with-primary/receipt-hmac` | 独立验证 execution/health receipt |
| `shared-with-primary/model-proxy-token` | workload 回调主 API 的 attempt-scoped model proxy |

`remote-only/` 下的 workload/delete token、cancel/tombstone HMAC、Inngest event/signing key、PostgreSQL/Redis password 永远不得复制给主 API。candidate 不接收上表任一项。

在主系统 `.env.production` 中设置现有 request/result/model token 的 `*_HOST_FILE` 为这些安全副本，并新增：

```dotenv
FACTORY_SB_RECEIPT_HMAC_HOST_FILE=/secure/agentic/factory-sandbox/receipt-hmac
EXTERNAL_SANDBOX_PUBLIC_RUNNER_ORIGIN=https://sandbox.internal.company
EXTERNAL_SANDBOX_KEY_ID=remote-key-v1
EXTERNAL_SANDBOX_RUNNER_ID=remote-runner-v1
EXTERNAL_SANDBOX_RUNNER_BUILD_ID=<exact-reviewed-build-id>
EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST=sha256:<exact-workload-oci-digest>
```

然后把 connector overlay 加到主 production stack：

```sh
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  -f deploy/factory-sandbox/compose.primary-external-connection.yml \
  config --quiet
```

这个 overlay 将 topology 设为 `external_sandbox`，配置 HTTPS runner URL，并把 key id、runner id、唯一 build id、唯一 workload digest 和独立 receipt key 精确注入 API。它不会把远端 broker 凭证或远端 Docker network 接到主 stack。

最后再运行主 API 的真实 sandbox probe。只有签名 `/health`、真实回放、App 删除反查、candidate 容器删除反查、model usage ledger 和 `remote_vm` receipt 全部通过，promotion gate 才能继续。

## 6. 回滚与销毁

- 镜像升级：发布新的 digest/build id，预载，更新两端 metadata，先 `config --quiet`，再逐服务滚动；不要轮换 durable HMAC 来“解决”旧 journal。
- 连接回滚：主 API 恢复上一组 exact build/workload digest allowlist；远端仍需保留对应镜像与 journal。
- 永久销毁：先停止接收 job、等待/取消 active attempts、确认 broker Apps 和 candidate containers 已不存在，备份审计证据，再显式删除 volumes 和 remote-only secrets。shared HMAC 的撤销必须与主 API 同步完成。

