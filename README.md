# Nimbus2k

A self-hosted deployment and container control plane for a single docker host.

Nimbus2k does two jobs, and the whole point is that it does them in one place:

- **Deploys.** A GitHub push lands on `/webhook`, Nimbus2k verifies the
  signature, fast-forwards the checkout and runs `docker compose up -d --build`.
  Every run is recorded with its full log.
- **Fleet.** Every container the docker daemon knows about, grouped by compose
  stack, by your own grouping, by the project that deploys it, by state or by
  image — with live CPU and memory, streamed logs, and start/stop/restart.

Server-rendered EJS, three runtime dependencies (`express`, `ejs`, `dotenv`),
SQLite through `node:sqlite`. No build step, no bundler, no client framework.

---

## Contents

- [Quick start](#quick-start)
- [Signing in](#signing-in)
- [Registering a project](#registering-a-project)
- [How a deploy works](#how-a-deploy-works)
- [The fleet view](#the-fleet-view)
- [Groups](#groups)
- [How it stays fast](#how-it-stays-fast)
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

docker compose up -d --build
docker compose logs nimbus2k
```

There is nothing to configure first. The first run generates an admin password
and a webhook secret, prints them once, and stores them — the password hashed —
beside the database:

```
────────────────────────────────────────────────────────────────────
  Nimbus2k generated credentials on this first run
────────────────────────────────────────────────────────────────────

  Sign in with:

      username   admin
      password   tbpxJasBP5GTjKJW

  GitHub webhook secret:

      74d27656915ccc11afbcd9900dc30530ff4ec1607ba0f40c
```

Both are shown again under Settings, so a lost terminal is not a lost install.
`.env` exists only to override things — see [Configuration](#configuration).

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
npm run dev
```

---

## Signing in

The UI takes a username and a password. The API takes either the same pair over
HTTP Basic, or a bearer token when `ADMIN_TOKEN` is set.

**Nimbus2k only ever holds a digest.** There is no step to remember and no tool
to run: whatever the password is, it is stored as scrypt and compared as scrypt.

To choose your own instead of the generated one, put it in `.env` and restart:

```ini
ADMIN_PASSWORD=at-least-twelve-characters
```

The next boot hashes it, stores the digest in `data/secrets.json`, and from then
on **that line can be deleted** — the password keeps working. Change the line
and the next boot re-hashes it; the old password stops working immediately.

Already manage a digest elsewhere? `ADMIN_PASSWORD_HASH` wins over everything.

Sessions live in memory in an `HttpOnly`, `SameSite=Strict` cookie scoped to
`/ui`, and last `SESSION_TTL_MS` (12 hours by default). A restart signs everyone
out. Sign-in is rate-limited per client address — ten attempts, then a
fifteen-minute lockout — and every attempt, successful or not, lands in the
audit log.

### Resetting a forgotten password

Delete `data/secrets.json` (or just its `adminPasswordHash`) and restart. A new
password is generated and printed. Nothing else in it is precious except the
webhook secret, which is printed again alongside.

---

## Registering a project

Give Nimbus2k four things and it does the rest:

| You give            | Example                                |
| ------------------- | -------------------------------------- |
| Repository URL      | `git@github.com:acme/billing-api.git`  |
| Where to put it     | `/srv/projects`                        |
| Branch              | `main`                                 |
| Group               | *Platform*, or none                    |
| Environment         | `DATABASE_URL`, `PORT`, …              |

The name comes from the URL — `billing-api` — because that is also the name
GitHub puts in the webhook payload, and the two have to agree for a push to find
the project. The checkout becomes the directory plus that name, so
`/srv/projects/billing-api`.

Registering then **schedules the first deploy immediately**, and that run clones
the repository before doing anything else:

```
[1/5] clone: git clone --branch main -- git@github.com:acme/billing-api.git /srv/projects/billing-api
[2/5] fetch: git fetch --prune origin
[3/5] reset: git reset --hard origin/main
[4/5] build: docker compose up -d --build --remove-orphans
[5/5] prune: docker image prune -f
```

The clone step only appears while the checkout is missing; once it exists, every
later deploy starts at `fetch`. So a project whose directory was wiped repairs
itself on the next deploy, and there is one code path rather than a separate
"provisioning" mode.

A private repository clones with whatever key is mounted at `/root/.ssh`. git is
run with `GIT_TERMINAL_PROMPT=0` and `ssh -o BatchMode=yes`, so a missing key
fails in a second with a readable message instead of hanging on a password
prompt nobody can answer until `STEP_TIMEOUT_MS` runs out.

The URL is checked before git ever sees it: only `https`, `http` and `ssh`, no
leading dash, no `ext::` transport, no `file://`. Those three are not
hypothetical — each one is a way to make `git clone` run a command or read a
path on this host.

If the checkout is already on disk, register without a URL and Nimbus2k deploys
it where it stands.


### The project's own .env

Most compose stacks want a `.env` next to the compose file — database passwords,
ports, API keys. That file is exactly what a repository must not contain, so
Nimbus2k holds it instead.

Give the variables as key/value pairs when registering (or paste a whole `.env`
into the box), and they are written into the checkout as one file at deploy
time:

```
[4/6] clean: git clean -fd
[5/6] env:   write .env — PORT, DATABASE_PASSWORD, GREETING
[6/6] build: docker compose up -d --build --remove-orphans
```

The order is the point. The file is written **after** `git clean -fd`, which
would otherwise delete it, and **before** `docker compose up`, which is what
reads it. So the values survive a fresh clone, a hard reset and a clean — the
checkout is disposable, the environment is not.

Values are written quoted when they need to be (`DATABASE_PASSWORD="a b \"c\" \$d"`)
so docker compose reads back exactly what you typed. The file is created at mode
0600. The deploy log records the variable **names** only; values never reach a
log, an audit entry or a page without being asked for.

Editing them later is the Environment card on the project page — save, then
deploy when you want them applied. A project with no variables set is left
alone: Nimbus2k writes nothing and whatever `.env` the checkout has is its own
business.


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
   git clone --branch <branch> -- <url> <path>   # only when there is no checkout yet
   git fetch --prune origin
   git reset --hard origin/<branch>
   git clean -fd                                 # only when "clean untracked" is on
   write .env                                    # only when the project has variables
   docker compose up -d --build --remove-orphans
   docker image prune -f                         # only when "prune images" is on
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

## How it stays fast

Every page an operator waits on renders in tens of milliseconds. That is not
free, because the docker CLI is not fast:

| call                       | cost   |
| -------------------------- | ------ |
| `docker stats --no-stream` | ~2.1 s |
| `docker system df`         | ~590 ms |
| `docker info`              | ~220 ms |
| `docker ps -a`             | ~110 ms |

`docker stats` costs two seconds whether there are two containers or fifty, so
**no request ever waits on it**. It is sampled behind the request and the page
renders with the last sample; the first fleet view after a restart simply has no
meters for a second. Everything else is stale-while-revalidate: the cached answer
is returned immediately and the refresh happens behind the response. A gauge that
is three seconds old beats a page that took three seconds to arrive.

The caches are filled at boot, after `listen`, so the first operator to open a
page does not pay for the first `docker system df` either.

The browser side follows the same rule. Instead of re-fetching a 20 kB page on a
timer, it polls `/ui/pulse` — a fingerprint of everything that would make a page
look different — every five seconds, and re-renders only when it changes. CPU
percentages are deliberately excluded from that fingerprint, so a meter twitching
by a tenth of a percent does not count as a change; the two pages that draw
meters ask for a slow full refresh on top.

Sitting idle on the fleet page for twenty seconds costs four ~30-byte polls and
one page refresh, against two full 1.2-second renders before. Any request over
400 ms is logged as `slow request`, so a regression here is visible rather than
merely felt.

---

## Configuration

**Every variable is optional.** Nimbus2k starts with no `.env` at all; the file
exists to override a default or to pin a secret it would otherwise generate.
`.env.example` lists them all commented out. The ones worth knowing:

| Variable                        | Default              | Meaning                                                        |
| ------------------------------- | -------------------- | -------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`         | *generated*          | HMAC secret for every delivery. Shown under Settings.          |
| `ADMIN_USER`                    | `admin`              | The operator who signs in.                                     |
| `ADMIN_PASSWORD`                | *generated*          | At least 12 characters. Hashed on the next boot, then deletable. |
| `ADMIN_PASSWORD_HASH`           | —                    | An scrypt digest you manage yourself. Wins over the above.     |
| `ADMIN_TOKEN`                   | —                    | Bearer token for the API. At least 16 characters.              |
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

Nimbus2k refuses to start only on a value it cannot interpret — a password
shorter than twelve characters, a token shorter than sixteen — and says which
one. It never starts with a default credential; a missing one is generated
instead.

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
POST   /api/v1/projects                  { repo_url, branch?, path?, group_id?, deploy? }
GET    /api/v1/projects/:name
PATCH  /api/v1/projects/:name
GET    /api/v1/projects/:name/env        { KEY: value }
PUT    /api/v1/projects/:name/env        replaces the whole set
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
  config/               every setting, plus first-run credential generation
  lib/                  logger, event bus, process spawning, passwords, validation, formatting
  db/                   connection, versioned migrations, one repository per table
  services/             deploy, docker (cached), fleet (grouping), auth
  http/
    middleware/         auth, security headers, errors, timing, view locals
    routes/
      webhook.routes.js
      api/              versioned JSON API
      ui/               one module per page, the SSE endpoints and /ui/pulse
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
   hard-coded fallback for it. That is gone. The UI now takes a username and a
   password; if you set neither, one is generated and printed on the first
   start. `ADMIN_TOKEN` survives as an optional API-only bearer token.
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
- Passwords are only ever stored as an scrypt digest (`N=16384, r=8, p=1`,
  64-byte key, random 16-byte salt), in `data/secrets.json` at mode 0600. A
  plaintext `ADMIN_PASSWORD` is hashed on the first boot that sees it and never
  written anywhere.
- The UI trades the credentials for a random session id once, kept in an
  `HttpOnly`, `SameSite=Strict` cookie scoped to `/ui`. Sessions live in memory:
  a restart signs everyone out.
- Login is rate-limited per client address, so one attacker cannot lock the real
  operator out.
- Every state-changing request checks `Origin`, and the CSP allows no external
  origin, no inline script and no framing.
- No shell is involved anywhere. Commands are spawned with an argument array, so
  a repository name, branch or container id can never be read as a command.
- A repository URL is parsed against a closed list of schemes before it reaches
  `git clone`, and passed after `--`. `ext::`, `file://` and a leading dash are
  all refused — each is a way to turn a clone into command execution or a read
  of this host's filesystem.
- Every state-changing action is written to the audit log, visible under
  Settings.
- **Mounting the docker socket is equivalent to root on the host.** That is why
  the port stays on loopback, the webhook is verified, the UI is behind a
  password, and destructive container actions are off until you turn them on.
