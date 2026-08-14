const {
    DOCKER_BIN, DOCKER_STATS_TTL_MS, DOCKER_PS_TTL_MS, DOCKER_TIMEOUT_MS,
    DOCKER_LOG_TAIL, CONTAINER_ACTIONS, CONTAINER_DESTRUCTIVE_ACTIONS,
} = require("../config");
const { capture, stream } = require("../lib/exec");
const { CONTAINER_REF, ValidationError } = require("../lib/validate");
const logger = require("../lib/logger");
const { publish } = require("../lib/bus");

const log = logger("docker");

// `docker ps --format "{{json .}}"` emits one JSON object per line rather than
// one array, which is what makes it streamable - and what makes this parse
// line by line.
const parseLines = (stdout) => stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
        try {
            return [JSON.parse(line)];
        } catch {
            // A warning from the daemon can share the stream with the data.
            return [];
        }
    });

// Labels arrive as one flat `k=v,k=v` string.
function parseLabels(raw) {
    const labels = {};
    if (!raw) return labels;

    for (const part of raw.split(",")) {
        const index = part.indexOf("=");
        if (index === -1) continue;
        labels[part.slice(0, index)] = part.slice(index + 1);
    }

    return labels;
}

// "0.0.0.0:3000->3000/tcp, :::3000->3000/tcp" collapses to one entry per
// published port: the IPv4 and IPv6 bindings of the same port are the same fact
// to anyone reading the table.
function parsePorts(raw) {
    if (!raw) return [];

    const seen = new Map();

    for (const part of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
        const match = /^(?:(.+):(\d+)->)?(\d+)\/(\w+)$/.exec(part);
        if (!match) continue;

        const [, host, published, container, protocol] = match;
        const key = `${published || ""}:${container}/${protocol}`;
        if (seen.has(key)) continue;

        seen.set(key, {
            host: host === "::" ? "0.0.0.0" : host || null,
            published: published ? Number(published) : null,
            container: Number(container),
            protocol,
            // Only a port bound to a routable address is reachable from
            // outside; loopback bindings are deliberate and worth showing
            // differently.
            public: Boolean(published) && host !== "127.0.0.1" && host !== "::1",
        });
    }

    return [...seen.values()];
}

// "Up 2 hours (healthy)" / "Up 5 seconds (health: starting)" / "Exited (1) ago"
function parseHealth(status) {
    if (/\(healthy\)/.test(status)) return "healthy";
    if (/\(unhealthy\)/.test(status)) return "unhealthy";
    if (/\(health: starting\)/.test(status)) return "starting";
    return null;
}

const parseExitCode = (status) => {
    const match = /^Exited \((\d+)\)/.exec(status);
    return match ? Number(match[1]) : null;
};

// The five states worth colouring differently. Anything else docker reports
// falls through as-is and renders neutral.
const STATE_TONE = {
    running: "ok",
    restarting: "warn",
    paused: "warn",
    created: "idle",
    removing: "warn",
    exited: "bad",
    dead: "bad",
};

function normalise(row) {
    const labels = parseLabels(row.Labels);
    const status = row.Status || "";
    const state = (row.State || "").toLowerCase();

    // A container started by `docker compose` carries the stack it belongs to
    // and the service it plays inside it. Everything else is a loose container.
    const stack = labels["com.docker.compose.project"] || null;

    return {
        id: row.ID,
        short: (row.ID || "").slice(0, 12),
        name: row.Names ? row.Names.split(",")[0] : row.ID,
        names: row.Names ? row.Names.split(",") : [],
        image: row.Image,
        command: row.Command ? row.Command.replace(/^"|"$/g, "") : "",
        state,
        tone: STATE_TONE[state] || "idle",
        status,
        health: parseHealth(status),
        exitCode: parseExitCode(status),
        running: state === "running",
        createdAt: row.CreatedAt,
        // docker phrases this as "2 months ago", which reads wrong next to the
        // label "uptime".
        uptime: (row.RunningFor || "").replace(/\s+ago$/, ""),
        ports: parsePorts(row.Ports),
        networks: row.Networks ? row.Networks.split(",").filter(Boolean) : [],
        mounts: row.Mounts ? row.Mounts.split(",").filter(Boolean) : [],
        size: row.Size || null,
        stack,
        service: labels["com.docker.compose.service"] || null,
        composeNumber: labels["com.docker.compose.container-number"] || null,
        workdir: labels["com.docker.compose.project.working_dir"] || null,
        labels,
    };
}

// ------------------------------------------------------------------ caching

// The fleet page, its auto-refresh and the SSE tick all want the same snapshot
// within the same second. One in-flight promise serves all of them.
function cached(ttlMs, producer) {
    let value = null;
    let expires = 0;
    let inflight = null;

    return function read({ force = false } = {}) {
        if (!force && value && Date.now() < expires) return Promise.resolve(value);
        if (inflight) return inflight;

        inflight = producer()
            .then((next) => {
                value = next;
                expires = Date.now() + ttlMs;
                return next;
            })
            .finally(() => { inflight = null; });

        return inflight;
    };
}

const docker = (args, options = {}) =>
    capture(DOCKER_BIN, args, { timeoutMs: DOCKER_TIMEOUT_MS, ...options });

// ------------------------------------------------------------------ probes

// Whether the daemon is reachable at all. Everything else in the fleet view
// degrades to an explanation rather than a stack trace when this is false.
const health = cached(10000, async () => {
    try {
        const { stdout } = await docker([
            "version", "--format", "{{json .Server}}",
        ], { timeoutMs: 5000 });

        const server = JSON.parse(stdout.trim() || "null");

        return {
            ok: Boolean(server),
            version: server?.Version || null,
            api: server?.ApiVersion || null,
            os: server?.Os || null,
            arch: server?.Arch || null,
            error: null,
        };
    } catch (err) {
        return { ok: false, version: null, api: null, os: null, arch: null, error: err.message };
    }
});

const listRaw = cached(DOCKER_PS_TTL_MS, async () => {
    const { stdout } = await docker(["ps", "--all", "--no-trunc", "--format", "{{json .}}"]);
    return parseLines(stdout).map(normalise);
});

// `docker stats` opens a stream per container even with --no-stream, so it is
// both the slowest call here and the one that matters least if it is a couple
// of seconds stale.
const statsRaw = cached(DOCKER_STATS_TTL_MS, async () => {
    try {
        const { stdout } = await docker(["stats", "--no-stream", "--format", "{{json .}}"]);

        return new Map(parseLines(stdout).map((row) => [row.Name, {
            cpu: parseFloat(row.CPUPerc) || 0,
            memPercent: parseFloat(row.MemPerc) || 0,
            mem: row.MemUsage,
            net: row.NetIO,
            block: row.BlockIO,
            pids: Number(row.PIDs) || 0,
        }]));
    } catch (err) {
        // A daemon under load can time this out while `ps` still answers; the
        // fleet view is useful without the meters.
        log.warn("stats unavailable", { error: err.message });
        return new Map();
    }
});

// ------------------------------------------------------------------ reads

async function list({ withStats = true, force = false } = {}) {
    const containers = await listRaw({ force });
    if (!withStats) return containers;

    const stats = await statsRaw();

    return containers.map((container) => ({
        ...container,
        stats: container.running ? stats.get(container.name) || null : null,
    }));
}

async function byRef(ref) {
    assertRef(ref);
    const containers = await list();
    return containers.find((item) => item.id === ref || item.short === ref || item.names.includes(ref)) || null;
}

async function inspect(ref) {
    assertRef(ref);

    const { stdout } = await docker(["inspect", ref]);
    const [raw] = JSON.parse(stdout);
    if (!raw) return null;

    const config = raw.Config || {};
    const state = raw.State || {};
    const host = raw.HostConfig || {};

    return {
        id: raw.Id,
        name: (raw.Name || "").replace(/^\//, ""),
        image: config.Image,
        imageId: raw.Image,
        created: raw.Created,
        startedAt: state.StartedAt,
        finishedAt: state.FinishedAt,
        restartCount: raw.RestartCount || 0,
        restartPolicy: host.RestartPolicy?.Name || "no",
        platform: raw.Platform,
        entrypoint: [].concat(config.Entrypoint || []).join(" "),
        command: [].concat(config.Cmd || []).join(" "),
        workingDir: config.WorkingDir || null,
        user: config.User || null,
        // Values are redacted: an env block routinely holds database passwords
        // and API keys, and this page is not the place to hand them out.
        env: (config.Env || []).map((entry) => {
            const index = entry.indexOf("=");
            const key = index === -1 ? entry : entry.slice(0, index);
            const value = index === -1 ? "" : entry.slice(index + 1);
            return { key, value, secret: SECRET_KEY.test(key) };
        }),
        mounts: (raw.Mounts || []).map((mount) => ({
            type: mount.Type,
            source: mount.Source || mount.Name,
            destination: mount.Destination,
            readonly: mount.RW === false,
        })),
        networks: Object.entries(raw.NetworkSettings?.Networks || {}).map(([name, net]) => ({
            name,
            ip: net.IPAddress || null,
            gateway: net.Gateway || null,
            aliases: net.Aliases || [],
        })),
        health: state.Health
            ? {
                status: state.Health.Status,
                failing: state.Health.FailingStreak,
                last: (state.Health.Log || []).slice(-5).reverse(),
            }
            : null,
        logDriver: host.LogConfig?.Type || null,
        labels: config.Labels || {},
    };
}

// A name that looks like a credential gets masked. Deliberately broad: a false
// positive costs one click on "reveal", a false negative leaks a secret.
const SECRET_KEY = /(PASS|SECRET|TOKEN|KEY|CRED|AUTH|PRIVATE|SALT|DSN|URI|URL)/i;

async function logs(ref, { tail = DOCKER_LOG_TAIL, timestamps = false } = {}) {
    assertRef(ref);

    const args = ["logs", "--tail", String(tail)];
    if (timestamps) args.push("--timestamps");
    args.push(ref);

    // Docker writes container stderr to our stderr, and for most images that is
    // where the application log actually goes.
    const { stdout, stderr } = await docker(args, { allowFailure: true });

    return `${stdout}${stderr}`.trimEnd();
}

// Follows a container's output until the caller disconnects.
function followLogs(ref, { onLine, tail = 100 }) {
    assertRef(ref);

    let stop = null;

    const done = stream(DOCKER_BIN, ["logs", "--tail", String(tail), "--follow", ref], {
        onLine,
        register: (fn) => { stop = fn; },
    }).catch((err) => {
        // A follower ends when the caller goes away or the container stops;
        // neither is worth reporting as a failure.
        log.debug("log follow ended", { ref, reason: err.message });
    });

    return { close: () => stop && stop(), done };
}

async function systemUsage() {
    try {
        const { stdout } = await docker(["system", "df", "--format", "{{json .}}"], { timeoutMs: 10000 });

        const rows = parseLines(stdout);
        const byType = Object.fromEntries(rows.map((row) => [row.Type, row]));

        const pick = (type) => ({
            count: Number(byType[type]?.TotalCount ?? byType[type]?.Total ?? 0) || 0,
            active: Number(byType[type]?.Active ?? 0) || 0,
            size: byType[type]?.Size || "0B",
            reclaimable: byType[type]?.Reclaimable || "0B",
        });

        return {
            ok: true,
            images: pick("Images"),
            containers: pick("Containers"),
            volumes: pick("Local Volumes"),
            cache: pick("Build Cache"),
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// `docker info` is asked for the whole document rather than a template that
// picks fields: the `dict` function templates would need is missing from some
// CLI builds, and the payload is a few kilobytes either way.
async function daemonInfo() {
    try {
        const { stdout } = await docker(["info", "--format", "{{json .}}"], { timeoutMs: 8000 });
        const raw = JSON.parse(stdout.trim());

        return {
            ok: true,
            name: raw.Name || null,
            cpus: raw.NCPU || 0,
            memory: raw.MemTotal || 0,
            driver: raw.Driver || null,
            images: raw.Images || 0,
            containers: raw.Containers || 0,
            running: raw.ContainersRunning || 0,
            paused: raw.ContainersPaused || 0,
            stopped: raw.ContainersStopped || 0,
            kernel: raw.KernelVersion || null,
            os: raw.OperatingSystem || null,
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ------------------------------------------------------------------ actions

const ACTIONS = {
    start: { args: (ref) => ["start", ref], verb: "started", destructive: false },
    stop: { args: (ref) => ["stop", "--time", "20", ref], verb: "stopped", destructive: false },
    restart: { args: (ref) => ["restart", "--time", "20", ref], verb: "restarted", destructive: false },
    pause: { args: (ref) => ["pause", ref], verb: "paused", destructive: false },
    unpause: { args: (ref) => ["unpause", ref], verb: "resumed", destructive: false },
    kill: { args: (ref) => ["kill", ref], verb: "killed", destructive: true },
    remove: { args: (ref) => ["rm", "--force", ref], verb: "removed", destructive: true },
};

function assertRef(ref) {
    if (typeof ref !== "string" || !CONTAINER_REF.test(ref)) {
        throw new ValidationError("Invalid container reference", "container");
    }
}

function assertAction(action) {
    const spec = ACTIONS[action];
    if (!spec) throw new ValidationError(`Unknown container action: ${action}`, "action");

    if (!CONTAINER_ACTIONS) {
        throw Object.assign(new Error("Container actions are disabled (CONTAINER_ACTIONS=false)"), { status: 403 });
    }

    if (spec.destructive && !CONTAINER_DESTRUCTIVE_ACTIONS) {
        throw Object.assign(
            new Error(`"${action}" is disabled (CONTAINER_DESTRUCTIVE_ACTIONS=false)`),
            { status: 403 },
        );
    }

    return spec;
}

async function act(ref, action) {
    const spec = assertAction(action);
    assertRef(ref);

    // `docker stop` on a container with a long shutdown takes as long as the
    // grace period, so it gets its own headroom rather than the default.
    await docker(spec.args(ref), { timeoutMs: Math.max(DOCKER_TIMEOUT_MS, 45000) });

    // The next `ps` must not come from cache, or the UI would redraw the state
    // the container had a second ago.
    await listRaw({ force: true });
    publish("containers", { reason: action, ref });

    return { ref, action, verb: spec.verb };
}

// A group or stack action is many single actions; one failure should not hide
// the others, so every result is reported.
async function actMany(refs, action) {
    assertAction(action);

    const results = [];

    for (const ref of refs) {
        try {
            await act(ref, action);
            results.push({ ref, ok: true });
        } catch (err) {
            results.push({ ref, ok: false, error: err.message });
        }
    }

    return results;
}

async function prune(what) {
    const targets = {
        images: ["image", "prune", "--force"],
        "images-all": ["image", "prune", "--all", "--force"],
        containers: ["container", "prune", "--force"],
        volumes: ["volume", "prune", "--force"],
        cache: ["builder", "prune", "--force"],
    };

    const args = targets[what];
    if (!args) throw new ValidationError(`Unknown prune target: ${what}`, "target");

    if (!CONTAINER_DESTRUCTIVE_ACTIONS) {
        throw Object.assign(
            new Error("Pruning is disabled (CONTAINER_DESTRUCTIVE_ACTIONS=false)"),
            { status: 403 },
        );
    }

    const { stdout } = await docker(args, { timeoutMs: 120000 });
    publish("containers", { reason: `prune:${what}` });

    const reclaimed = /Total reclaimed space:\s*(.+)/.exec(stdout);
    return { target: what, reclaimed: reclaimed ? reclaimed[1].trim() : "0B" };
}

module.exports = {
    list,
    byRef,
    inspect,
    logs,
    followLogs,
    health,
    systemUsage,
    daemonInfo,
    act,
    actMany,
    prune,
    ACTIONS,
    STATE_TONE,
    canAct: CONTAINER_ACTIONS,
    canDestroy: CONTAINER_DESTRUCTIVE_ACTIONS,
};
