# deploy-server

GitHub push webhook listener. On a verified push it fast-forwards the checkout
under `PROJECTS_DIR` and rebuilds it with `docker compose up -d --build`.

Registered repositories, their per-repo settings and the deploy history live in
a SQLite file (`node:sqlite`, no native dependency).

## Requirements

Node >= 22.5 (`node:sqlite`), git and docker compose on the host.

## Layout

```
server.js            binds the port; everything else is wiring
src/
  app.js             express setup and route mounting
  config.js          environment, validated once at boot
  db.js              sqlite schema and every query
  deployer.js        the deploy loop, its event bus and cancellation
  auth.js            token compare, UI sessions, login throttle
  format.js          time and duration helpers shared by the views
  validate.js        the name patterns that guard filesystem paths
  routes/
    webhook.js       POST /webhook, HMAC verified
    api.js           the token-authenticated JSON API
    ui.js            the dashboard, its forms and the event stream
views/               EJS templates
public/              stylesheet and the client script
nginx/               vhost templates for the host nginx
scripts/             one-shot server setup
```

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

## Web UI

`/ui` serves an EJS dashboard: success rate and average duration, what is
deploying right now, every registered repository with the outcome of its last
run, and the log of any single deploy. Each repository has a page for manual
deploys, cancellation and its registry fields. `/` redirects there.

| | |
|---|---|
| live updates | `GET /ui/events` is a server-sent event stream. Log lines appear as they are written, and a run starting or ending refreshes the open page. No polling, no manual reload. |
| cancel | Stops the running step and records the deploy as `cancelled`. |
| redeploy | Runs the same branch again from any row in the history. |
| filter | Type in the repository filter, or press `/` from anywhere on the dashboard. |
| raw log | `GET /ui/deployments/:id/raw` is the plain text, for piping into anything else. |
| register by hand | For a checkout outside `PROJECTS_DIR`, or when `AUTO_REGISTER` is off. |

A browser cannot attach an `Authorization` header to a navigation, so the login
form trades `ADMIN_TOKEN` for a random session id held in memory and returned
in an `HttpOnly`, `SameSite=Strict` cookie. Sessions last 12 hours and a
restart clears them. Login is throttled to 10 attempts per client address per
15 minutes, and state-changing posts also check the `Origin` header.

The log of a running deploy lives in the deployer's buffer and reaches the
database only when the run ends, so a tab opened halfway through is served the
buffer and then follows the stream.

Cancelling kills the step's whole process group. `git` shells out to `ssh` and
`docker compose` to buildkit; killing only the direct child leaves the
grandchild holding the pipes open, and the step hangs instead of stopping.

The client script has no build step and no dependencies. Without JavaScript
every page still renders and every form still works — only the live updates are
lost.

## TLS through the host nginx

TLS terminates in the nginx already running on the host, which proxies to the
container on `127.0.0.1:$PORT`. Nothing in `docker-compose.yml` binds 80 or
443, so the other sites that nginx serves are untouched.

On the server:

1. Point an A record for `DOMAIN` at the server and open ports 80 and 443.
2. Set `DOMAIN` and `LETSENCRYPT_EMAIL` in `.env`.
3. Run the setup once:

```sh
sudo ./scripts/setup-nginx-tls.sh
```

It installs a challenge-only vhost, requests the certificate over HTTP-01,
then swaps in the TLS vhost — nginx refuses to start while `ssl_certificate`
points at a file that does not exist yet, which is why it takes two passes.
Set `CERTBOT_STAGING=1` for a dry run against the staging CA first: five failed
production attempts per hour lock the domain out for the rest of that hour.

Renewals come from the host's own `certbot.timer`. The script drops
`/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` so a renewed
certificate is reloaded without manual work.

The vhost source is `nginx/deploy-server.conf.template`, with `__DOMAIN__` and
`__PORT__` substituted at install time. It is **copied** into `/etc/nginx`,
never symlinked: the deploy workflow runs `git checkout -- .`, which would
revert anything written back into the checkout. Editing the template therefore
means rerunning the script.

The vhost gives `/ui/events` its own `location` with `proxy_buffering off` and
a one-hour read timeout. Without it nginx would hold every log line until the
deploy ended and then drop the stream after a minute of quiet.

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

`GET /healthz` and `POST /webhook` are public; `/ui` uses the cookie session
described above. Everything else needs `Authorization: Bearer $ADMIN_TOKEN`,
and returns 503 until `ADMIN_TOKEN` is set.

| Route | Purpose |
|---|---|
| `GET /healthz` | liveness |
| `GET /ui` | dashboard, cookie session |
| `GET /ui/events` | server-sent deploy events, cookie session |
| `POST /webhook` | GitHub push handler, HMAC verified |
| `GET /status` | in-flight deploys plus the 10 most recent |
| `GET /repos` | list registered repositories |
| `POST /repos` | register one: `{ name, branch?, path?, compose_file? }` |
| `PATCH /repos/:name` | update any registry field |
| `DELETE /repos/:name` | unregister, dropping its history |
| `POST /repos/:name/deploy` | trigger manually: `{ branch? }` |
| `POST /repos/:name/cancel` | kill the running deploy, 409 when nothing runs |
| `GET /deployments?repo=&limit=` | history without logs |
| `GET /deployments/:id` | one deploy including its captured log |

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" localhost:3000/deployments?repo=my-app
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" localhost:3000/repos/my-app/deploy
```

Each deploy keeps the last `LOG_TAIL_BYTES` of output; each repository keeps
its last `DEPLOYMENT_HISTORY` deploys.
