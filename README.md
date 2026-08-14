# deploy-server

GitHub push webhook listener. On a verified push it fast-forwards the checkout
under `PROJECTS_DIR` and rebuilds it with `docker compose up -d --build`.

Registered repositories, their per-repo settings and the deploy history live in
a SQLite file (`node:sqlite`, no native dependency).

## Requirements

Node >= 22.5 (`node:sqlite`), git and docker compose on the host.

## Setup

```sh
npm install
cp .env.example .env      # fill in GITHUB_WEBHOOK_SECRET and ADMIN_TOKEN
npm start
```

Point the GitHub webhook at `POST /webhook`, content type `application/json`,
using the same secret as `GITHUB_WEBHOOK_SECRET`.

Bind stays on `127.0.0.1` by default. Put a TLS reverse proxy in front rather
than exposing the port.

## Running in docker

```sh
cp .env.example .env      # GITHUB_WEBHOOK_SECRET and ADMIN_TOKEN only
docker compose up -d --build
```

The image carries the `git` and `docker compose` CLIs; the daemon comes from
the mounted host socket. `HOST`, `PORT`, `PROJECTS_DIR` and `DB_PATH` are
pinned in `docker-compose.yml` and ignored from `.env`, because only those
values work inside the container.

Three details decide whether this works:

- **`/srv/projects` mounts at the identical path on both sides.** A nested
  `docker compose up` is executed by the host daemon, so a project's relative
  bind mounts resolve against the host filesystem. A different container path
  silently mounts the wrong directories.
- **The docker socket grants root on the host.** That is why the port publishes
  to `127.0.0.1` and every webhook is HMAC verified.
- **Private repositories need their deploy key inside the container.** Point
  `SSH_DIR` at the key directory, or switch the checkouts to https with a
  token and drop that volume.

The SQLite file lives on the `deploy-data` volume, so the registry and history
survive `up --build`. It needs no container of its own: it is a file, not a
server.

Deploying `deploy-server` through itself restarts its own container mid-run and
the deploy never reports back. Keep using the SSH workflow in
`.github/workflows/deploy.yml` for this repository, or disable it with
`PATCH /repos/deploy-server {"enabled": false}`.

## TLS with nginx and certbot

`docker-compose.yml` also carries an nginx reverse proxy and a certbot
renewal loop, so the stack terminates TLS itself. nginx owns ports 80 and 443;
the app container stays published on `127.0.0.1` for local `curl` only.

Before the first start, on the server:

1. Point an A record for `DOMAIN` at the server and open ports 80 and 443.
2. Set `DOMAIN` and `LETSENCRYPT_EMAIL` in `.env` — `docker compose` refuses to
   start without `DOMAIN`, including from the deploy workflow.
3. Run the bootstrap once:

```sh
./scripts/init-letsencrypt.sh
```

It writes a throwaway self-signed pair so nginx can boot, requests the real
certificate over the HTTP-01 challenge, then reloads. Set `CERTBOT_STAGING=1`
for a dry run against the staging CA first: five failed production attempts per
hour lock the domain out for the rest of that hour.

From then on the certbot container tries a renewal every 12 hours and nginx
reloads every 6, so a renewed certificate is picked up without a restart. The
script is idempotent — rerunning it with a certificate already on the volume
just starts the stack.

The vhost lives in `nginx/templates/deploy-server.conf.template`; `${DOMAIN}`
is the only value substituted at container start, so nginx's own `$host` and
`$remote_addr` survive. Certificates and challenge files sit on the
`certbot-conf` and `certbot-www` volumes and outlive `up --build`.

Point the GitHub webhook at `https://$DOMAIN/webhook`.

## Repository registry

A push from an unregistered repository registers itself when
`PROJECTS_DIR/<name>/.git` exists, taking the pushed branch as its deploy
branch. Set `AUTO_REGISTER=false` to require `POST /repos` instead.

| Field | Default | Meaning |
|---|---|---|
| `name` | - | GitHub repository name |
| `branch` | `master` | only pushes to this branch deploy |
| `path` | `PROJECTS_DIR/<name>` | checkout on the server |
| `compose_file` | `null` | passed as `docker compose -f <file>` |
| `enabled` | `true` | `false` ignores pushes without deleting history |
| `prune_images` | `true` | run `docker image prune -f` after the build |
| `clean_untracked` | `false` | run `git clean -fd`; deletes untracked files, including a repo-local `.env` |

## Deploy steps

```
git fetch --prune origin
git reset --hard origin/<branch>
git clean -fd                      # only when clean_untracked
docker compose [-f <file>] up -d --build
docker image prune -f              # only when prune_images
```

Commands run through `spawn` with an argument array, never a shell, so no
payload value can be interpreted as a command. One deploy runs per repository
at a time; pushes arriving mid-deploy collapse into a single follow-up run.

## API

`GET /healthz` and `POST /webhook` are public. Everything else needs
`Authorization: Bearer $ADMIN_TOKEN`, and returns 503 until `ADMIN_TOKEN` is set.

| Route | Purpose |
|---|---|
| `GET /healthz` | liveness |
| `POST /webhook` | GitHub push handler, HMAC verified |
| `GET /status` | in-flight deploys plus the 10 most recent |
| `GET /repos` | list registered repositories |
| `POST /repos` | register one: `{ name, branch?, path?, compose_file? }` |
| `PATCH /repos/:name` | update any registry field |
| `DELETE /repos/:name` | unregister, dropping its history |
| `POST /repos/:name/deploy` | trigger manually: `{ branch? }` |
| `GET /deployments?repo=&limit=` | history without logs |
| `GET /deployments/:id` | one deploy including its captured log |

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" localhost:3000/deployments?repo=my-app
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" localhost:3000/repos/my-app/deploy
```

Each deploy keeps the last `LOG_TAIL_BYTES` of output; each repository keeps
its last `DEPLOYMENT_HISTORY` deploys.
