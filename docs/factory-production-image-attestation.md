# Production image attestation runbook

`setup:factory-production` creates one persistent Ed25519 trust root under
`.secrets/agent-factory/production-image-attestation`. `private.pem` stays on
the primary host with mode `0600`; Compose mounts only `public.pem` into the
API, read-only. The API cannot mint its own readiness proof.

## Topologies

- `external_sandbox` is the only promotable topology. The host proof covers
  the local `api`, `web`, `codeact-executor` containers and the curated
  CodeAct candidate image. Remote runner/workload/gateway identities are not
  invented as local Docker observations: their signed health/execution
  receipts must match the one allowed runner id, runner build id and workload
  digest configured on the API.
- `single_host_compose` is a useful diagnostic profile. Its proof additionally
  covers the local runner/workload/gateway containers, but every result is
  downgraded to `development_only`; the production probe returns `passed=false`
  and promotion rejects it.

To select `external_sandbox`, put these explicit inputs in the operator `.env`
or setup environment before running setup:

```dotenv
FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY=external_sandbox
FACTORY_SB_RUNNER_URL=https://factory-sandbox.internal.example.com
FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS=factory-sandbox.internal.example.com
FACTORY_SB_KEY_ID=factory-sandbox-key-v1
FACTORY_SB_RUNNER_ID=factory-sandbox-runner-v1
FACTORY_SB_ALLOWED_BUILD_IDS=["remote-runner-build-v1"]
FACTORY_SB_ALLOWED_IMAGE_DIGESTS=["sha256:<64-lowercase-hex>"]
```

External runner traffic must use HTTPS. Both allowlists must be singletons;
setup refuses wildcard/fallback identities and never substitutes locally built
runner images. Deploy and attest the remote plane independently, with
`remote_container` or `remote_vm` isolation, following
[the external sandbox runbook](./agent-factory-external-sandbox.md).

Setup creates stable request/result HMAC files for the primary API. Provision
the matching values into the remote control runner through its secret manager;
do not copy them into workload, gateway, candidate images, logs, or an env file
in source control. Setup cannot provision a remote VM/cluster and does not
report external readiness until signed health and execution receipts verify.

## Continuous host verifier

After starting or replacing the primary production stack, run the verifier as
the same non-root host account that owns the workspace:

```sh
pnpm run watch:factory-production-images
```

The watcher re-reads `.env.production` and performs fresh Docker container and
candidate-image inspection on every round. It atomically signs a new document
at no more than one third of
`FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS` (five minutes by default). A
failed inspection never overwrites the last valid document; that document
expires and `/health`, sandbox deployment, the production probe, and promotion
fail closed. `/live` remains a process-liveness endpoint so container startup
does not deadlock on a proof that can only be minted after containers are
healthy. Load balancers and operators must continue to use `/health` for
readiness.

`SIGINT` and `SIGTERM` stop the watcher cleanly. Run it under the host's normal
service manager. For example (replace paths and user explicitly):

```ini
[Unit]
Description=Agentic production image verifier
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=agentic
WorkingDirectory=/srv/agentic-operator
ExecStart=/usr/bin/pnpm run watch:factory-production-images
Restart=always
RestartSec=5
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

Do not put `private.pem` in an image, Compose secret, API environment, API
mount, or remote runner. Back it up as a host trust root. If it is lost while
`public.pem` remains, setup stops instead of silently replacing deployment
identity. Key rotation is an explicit maintenance event: stop the verifier,
drain protected operations, replace the pair together, rerun setup, restart
the stack, and wait for a new signed proof before restoring traffic.
