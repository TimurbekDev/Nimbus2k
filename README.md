# Nimbus2k

A self-hosted deployment and container control plane for a single docker host.

Nimbus2k does two jobs, and the whole point is that it does them in one place:

- **Deploys.** A GitHub push lands on `/webhook`, Nimbus2k verifies the
  signature, fast-forwards the checkout and runs `docker compose up -d --build`.
  Every run is recorded with its full log.
- **Fleet.** Every container the docker daemon knows about, grouped by compose
  stack, by your own grouping, by the project that deploys it, by state or by
  image — with live CPU and memory, streamed logs, and start/stop/restart.

Server-rendered EJS, two runtime dependencies (`express`, `ejs`), SQLite through
`node:sqlite`. No build step, no bundler, no client framework.

---

## Contents

- [Quick start](#quick-start)
- [Signing in](#signing-in)
- [How a deploy works](#how-a-deploy-works)
- [The fleet view](#the-fleet-view)
- [Groups](#groups)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Running behind a reverse proxy](#running-behind-a-reverse-proxy)
- [Project layout](#project-layout)
- [Upgrading from deploy-server 1.x](#upgrading-from-deploy-server-1x)
- [Security notes](#security-notes)

---

## Quick start

```bash
git clone https://github.com/TimurbekDev/nimbus2k.git /srv/projects/nimbus2k
cd /srv/projects/nimbus2k

cp .env.example .env
```

Fill in `.env`. Three values are required and Nimbus2k will not start without
them:

```ini
GITHUB_WEBHOOK_SECRET=...        # the same secret you give GitHub
ADMIN_USER=admin
ADMIN_PASSWORD=...               # at least 12 characters
```

Then:

```bash
docker compose up -d --build
```

Point a GitHub webhook at `https://your-host/webhook`:

| Setting      | Value                       |
| ------------ | --------------------------- |
| Payload URL  | `https://your-host/webhook` |
| Content type | `application/json`          |
| Secret       | `GITHUB_WEBHOOK_SECRET`     |
| Events       | Just the push event         |

Open `https://your-host/ui` and sign in.

Running without docker, for development:

```bash
npm install
GITHUB_WEBHOOK_SECRET=dev ADMIN_USER=admin ADMIN_PASSWORD=dev-password-1234 npm run dev
```

---

## Signing in

The UI takes a username and a password. The API takes either the same pair over
HTTP Basic, or a bearer token when `ADMIN_TOKEN` is set.

**Store the password as a digest** rather than in the clear — a leaked `.env`
then costs you one system rather than every system where that password was
reused:

```bash
npm run hash-password
# Password: ····························
#
# Add this to .env, and remove ADMIN_PASSWORD:
#
# ADMIN_PASSWORD_HASH=scrypt$16384$8$1$…
```

Put the line in `.env`, delete `ADMIN_PASSWORD`, restart. When both are present
the hash wins.

Sessions live in memory in an `HttpOnly`, `SameSite=Strict` cookie scoped to
`/ui`, and last `SESSION_TTL_MS` (12 hours by default). A restart signs everyone
out. Sign-in is rate-limited per client address — ten attempts, then a
fifteen-minute lockout — and every attempt, successful or not, lands in the
audit log.

---

## How a deploy works

1. GitHub posts to `/webhook`. The HMAC in `X-Hub-Signature-256` is checked
   against the raw request body; anything else is rejected with 401.
2. The repository name is matched against the registry. If it is unknown and
   `AUTO_REGISTER` is on, a project is created automatically as long as
   `PROJECTS_DIR/<name>/.git` already exists.
3. Pushes to any branch other than the project's branch are recorded and
   ignored — the delivery log on the project page explains exactly why nothing
   happened.
4. The run executes, in the checkout, in order:

   ```
   git fetch --prune origin
   git reset --hard origin/<branch>
   git clean -fd                      # only when "clean untracked" is on
   docker compose up -d --build --remove-orphans
   docker image prune -f              # only when "prune images" is on
   ```

Each line of output is streamed to every open browser tab over server-sent
events and stored with the run when it ends.

One deploy per project at a time. Pushes arriving mid-deploy collapse into a
single follow-up run, so three commits landing during a build produce one more
deploy rather than three. A step that runs longer than `STEP_TIMEOUT_MS` is
killed, and so is its whole process group — git shells out to ssh and compose to
buildkit, and killing only the direct child would leave the run hanging.

---

## The fleet view

`/ui/containers` reads the docker daemon directly. Nothing about a container is
cached in the database; the only thing Nimbus2k stores is your annotation of it
(group, pin, note), keyed by name so it survives the container being recreated.

Group the fleet by:

| Axis              | Answers                                       |
| ----------------- | --------------------------------------------- |
| **Compose stack** | what docker itself thinks belongs together    |
| **Group**         | your own grouping, which can span stacks      |
| **Project**       | which repository deploys this container       |
| **State**         | what is running, stopped, paused or unhealthy |
| **Image**         | every replica of the same image               |
| **Flat list**     | no grouping                                   |

Sort by state (anything unhealthy first), name, CPU, memory or age; filter by
free text, by state, or by group. The whole view lives in the query string, so a
filtered fleet is a link you can paste into a ticket.

Per container: start, stop, restart, pause, resume, live log follow, ports,
mounts, networks, health-check history and environment — with anything that
looks like a credential masked until you click *reveal*.

Per bucket: restart everything in it, stop everything running, or start
everything stopped. Membership is resolved server-side from the bucket identity,
so a form never posts a container list a client could have rewritten.

Container actions are behind `CONTAINER_ACTIONS` (on by default); `kill`,
`remove` and pruning are behind `CONTAINER_DESTRUCTIVE_ACTIONS` (off by
default).

If the docker socket is not mounted, the fleet view explains itself and the rest
of Nimbus2k keeps working.

---

## Groups

A compose stack is one file. A group is whatever you say it is: "customer
facing", "everything the billing team owns", "restart these together after a
database upgrade". A group holds **projects and containers at the same time**,
and can be acted on as a unit — deploy every project in it, restart every
container in it.

Deleting a group never deletes anything inside it; members simply become
ungrouped.

---

## Configuration

Every setting is read from the environment at boot. `.env.example` documents all
of them; the ones worth knowing:

| Variable                        | Default              | Meaning                                                        |
| ------------------------------- | -------------------- | -------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`         | —                    | **Required.** HMAC secret for every delivery.                  |
| `ADMIN_USER`                    | `admin`              | **Required.** The operator who signs in.                       |
| `ADMIN_PASSWORD`                | —                    | **Required** unless a hash is set. At least 12 characters.     |
| `ADMIN_PASSWORD_HASH`           | —                    | scrypt digest from `npm run hash-password`. Wins over the above. |
| `ADMIN_TOKEN`                   | —                    | Optional bearer token for the API. At least 16 characters.     |
| `SESSION_TTL_MS`                | `43200000`           | How long a browser session lasts.                              |
| `PROJECTS_DIR`                  | `/srv/projects`      | Where checkouts live.                                          |
| `DB_PATH`                       | `./data/nimbus2k.db` | Registry, history, groups, audit log.                          |
| `AUTO_REGISTER`                 | `true`               | An unknown repo with a checkout registers itself.              |
| `STEP_TIMEOUT_MS`               | `900000`             | A deploy step running longer than this is killed.              |
| `DEPLOYMENT_HISTORY`            | `50`                 | Runs kept per project.                                         |
| `LOG_TAIL_BYTES`                | `65536`              | Log kept per run.                                              |
| `CONTAINER_ACTIONS`             | `true`               | Start / stop / restart / pause from the UI.                    |
| `CONTAINER_DESTRUCTIVE_ACTIONS` | `false`              | `kill`, `remove` and pruning.                                  |
| `APP_NAME` / `APP_TAGLINE`      | `Nimbus2k` / …       | Branding in the sidebar, title and login card.                 |
| `LOG_LEVEL`                     | `info`               | `debug` \| `info` \| `warn` \| `error`.                        |

Nimbus2k prints what is wrong and exits when a required value is missing, rather
than starting with a default credential.

---

## HTTP API

Everything the UI does is available over HTTP. Authenticate with the username
and password:

```bash
curl -u "admin:$ADMIN_PASSWORD" http://127.0.0.1:3000/api/v1/status
```

or, when `ADMIN_TOKEN` is set, with a bearer header:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:3000/api/v1/status
```

`GET /api/v1` lists every endpoint. The shape of it:

```
GET    /api/v1/status                    scheduler and deploy stats
GET    /api/v1/system                    docker health, daemon info, disk usage

GET    /api/v1/projects                  registry, each with its last run
POST   /api/v1/projects                  register one
GET    /api/v1/projects/:name
PATCH  /api/v1/projects/:name
DELETE /api/v1/projects/:name
POST   /api/v1/projects/:name/deploy     { branch? } -> 202
POST   /api/v1/projects/:name/cancel

GET    /api/v1/deployments               ?project= &status= &limit= &offset=
GET    /api/v1/deployments/:id
GET    /api/v1/deployments/:id/log       text/plain

GET    /api/v1/containers                ?by= &sort= &state= &q= &fresh=1
GET    /api/v1/containers/:ref           includes the full inspect
GET    /api/v1/containers/:ref/logs      text/plain
PATCH  /api/v1/containers/:ref           { group_id, pinned, note }
POST   /api/v1/containers/:ref/:action   start|stop|restart|pause|unpause|kill|remove

GET    /api/v1/groups
POST   /api/v1/groups
GET    /api/v1/groups/:id
PATCH  /api/v1/groups/:id
DELETE /api/v1/groups/:id
```

`GET /healthz` is the only unauthenticated route, so a load balancer can ask.

---

## Running behind a reverse proxy

Nimbus2k binds to loopback and expects TLS to terminate in front of it. Any
proxy will do; two things it has to get right:

- **Forward the real client address and scheme.** `TRUST_PROXY` tells Nimbus2k
  how many hops to trust, so `X-Forwarded-For` and `X-Forwarded-Proto` decide
  the rate-limit key and whether the session cookie is marked `Secure`.
- **Do not buffer the event streams.** `/ui/events` and
  `/ui/containers/<name>/stream` are server-sent events; a buffering proxy holds
  every log line back until the response ends, and a short read timeout drops a
  connection that is deliberately long-lived.

nginx:

```nginx
location ~ ^/ui/(events|containers/[^/]+/stream)$ {
    proxy_pass http://127.0.0.1:7777;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
}

location / {
    proxy_pass http://127.0.0.1:7777;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 2m;
}
```

Caddy needs no configuration for either — it forwards the headers and does not
buffer:

```caddyfile
nimbus2k.example.com {
    reverse_proxy 127.0.0.1:7777
}
```

---

## Project layout

```
src/
  index.js              bootstrap: listen, graceful shutdown
  app.js                express wiring
  config/               every setting, validated once at boot
  lib/                  logger, event bus, process spawning, passwords, validation, formatting
  db/                   connection, versioned migrations, one repository per table
  services/             deploy, docker, fleet (grouping), auth
  http/
    middleware/         auth, security headers, errors, view locals
    routes/
      webhook.routes.js
      api/              versioned JSON API
      ui/               one module per page + the SSE endpoints
  tools/                hash-password
views/
  partials/             shell, sidebar, topbar, icon sprite, shared fragments
  pages/                one template per page
public/
  css/                  tokens → base → layout → components → pages
  js/                   theme (pre-paint), app (streams, palette, shortcuts)
```

The layering is strict in one direction: routes call services, services call the
db layer and `lib`, and nothing calls back up. A route never runs SQL and a
service never touches `req`.

Database changes go in `src/db/migrations.js` as a new numbered entry — never by
editing one that has shipped. Each runs once, in a transaction, and the applied
version is stored in sqlite's `user_version`.

---

## Upgrading from deploy-server 1.x

Nimbus2k is the same application, renamed and restructured. An in-place upgrade
works, with three things to know:

1. **Sign-in changed.** 1.x accepted a single `ADMIN_TOKEN` — and shipped a
   hard-coded fallback for it. That is gone. Set `ADMIN_USER` and
   `ADMIN_PASSWORD` (or `ADMIN_PASSWORD_HASH`) in `.env` before restarting, or
   the process exits with an explanation. `ADMIN_TOKEN` survives as an optional
   API-only bearer token.
2. **The database is adopted automatically.** An existing
   `data/deploy-server.db` (or `data/nimbus.db`) is renamed to
   `data/nimbus2k.db` on first start and migrated: `repos` becomes `projects`,
   and groups, container annotations, the audit log and the webhook delivery log
   are added. Nothing is lost.
3. **The API moved to `/api/v1`.** The old root-level `/repos`, `/deployments`
   and `/status` are gone; `/webhook` and `/healthz` are unchanged.

The compose service, container and volume are renamed, so the first
`docker compose up -d --build` leaves the old container behind. Remove it once
the new one is healthy:

```bash
docker rm -f deploy-server
```

---

## Security notes

- The webhook is HMAC-verified against the raw body, compared in constant time.
- Sign-in checks the username and the password every time, even when the name is
  already wrong, so both halves cost the same amount of work and the error
  message never says which one was wrong.
- Passwords may be stored as an scrypt digest (`N=16384, r=8, p=1`, 64-byte key,
  random 16-byte salt) rather than in the clear.
- The UI trades the credentials for a random session id once, kept in an
  `HttpOnly`, `SameSite=Strict` cookie scoped to `/ui`. Sessions live in memory:
  a restart signs everyone out.
- Login is rate-limited per client address, so one attacker cannot lock the real
  operator out.
- Every state-changing request checks `Origin`, and the CSP allows no external
  origin, no inline script and no framing.
- No shell is involved anywhere. Commands are spawned with an argument array, so
  a repository name, branch or container id can never be read as a command.
- Every state-changing action is written to the audit log, visible under
  Settings.
- **Mounting the docker socket is equivalent to root on the host.** That is why
  the port stays on loopback, the webhook is verified, the UI is behind a
  password, and destructive container actions are off until you turn them on.
