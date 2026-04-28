# Deployment and operations

## Runtime shape

`backend_new` is deployed as two cooperating processes:

- HTTP/REST/WebSocket server
- queue worker

They share the same storage truth:

- Postgres for production persistence and queue state
- file storage only for development or test fallback

## Startup commands

- `npm run migrate`
- `npm run start`
- `npm run start:worker`

The intended production order is:

1. apply migrations
2. start the server
3. start one or more workers

## Health and readiness

- `/health`
  Returns process-level health plus database and queue enablement flags.
- `/ready`
  Returns dependency readiness. In Postgres mode this includes a real database ping. When the queue is enabled, readiness also requires a worker-enabled instance.

`/ready` should be used for orchestration gating.

## Control-plane access

- control-plane HTTP and WebSocket surfaces are loopback-first by default
- browser CORS is only granted to loopback or same-host origins
- the default browser workbench contract is same-machine / loopback-first, not a general remote browser console
- non-loopback automation and integration clients can authenticate with `Authorization: Bearer <token>` when `BACKEND_NEW_CONTROL_API_TOKEN` is configured

This prevents arbitrary public web pages from calling the local control plane on `127.0.0.1`.

## Queue operations

The REST layer intentionally exposes minimal operator actions:

- `GET /queue/active`
- `GET /queue/dead-letters`
- `POST /queue/recover-expired`
- `POST /queue/dead-letters/:taskId/requeue`

These endpoints are diagnostic and recovery tools. They do not redefine queue state outside the repository-backed worker flow.

## Postgres integration testing

The live Postgres integration suite is environment-gated:

- canonical entrypoint: `npm run test:postgres`
- local ignored helper: `npm run test:postgres:local`

It uses:

- `BACKEND_NEW_PG_TEST_URL`, or
- `BACKEND_NEW_DATABASE_URL`

Recommended local database name:

- `scc_batch_test`

Recommended connection string shape:

- `postgres://postgres:postgres@127.0.0.1:5432/scc_batch_test`

Behavior:

- missing env remains an `external_blocker`
- connection, migration, and test failures remain real failures
- the local helper reads `.env.postgres.local` and does not commit connection strings into the repository

## Configuration guidance

Recommended production settings:

- `BACKEND_NEW_STORAGE_DRIVER=postgres`
- `BACKEND_NEW_QUEUE_ENABLED=true`
- `BACKEND_NEW_WORKER_ENABLED=true`
- `BACKEND_NEW_DATABASE_AUTO_MIGRATE=false`
- `BACKEND_NEW_CONTROL_API_TOKEN=<strong-random-token>`
- `BACKEND_NEW_SECRET_KEY=<32-byte-base64-or-hex-key>`

The preferred pattern is explicit migration execution via `npm run migrate`, not implicit schema changes during every process boot.

## Secret storage

- provider secrets now default to `aes-256-gcm` at rest
- when `BACKEND_NEW_SECRET_KEY` is not provided, local file-mode environments generate a persistent key file under the secrets directory
- explicit plaintext secret storage remains an opt-in compatibility mode, not the default

## Context and trace policy

- provider-facing context may be compressed for budget control
- user-visible conversation is never compressed
- checkpoints must preserve references to both tracks
- trace and audit remain append-only operational facts

This separation is part of the architecture and must not be bypassed in deployment-specific code.
