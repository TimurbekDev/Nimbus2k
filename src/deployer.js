const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

const { STEP_TIMEOUT_MS, LOG_TAIL_BYTES } = require("./config");
const { deployments } = require("./db");

// Everything that wants to watch a deploy as it happens subscribes here; the
// SSE endpoint fans these out to every open browser tab. No listener cap: one
// per connected tab is normal and none of them leak, they unsubscribe on close.
const events = new EventEmitter();
events.setMaxListeners(0);

// One deploy per repository at a time. Pushes arriving mid-deploy collapse
// into a single follow-up run instead of stacking up.
const queue = new Map();

// Lines of a run that has not finished yet. The database only receives the log
// when the deploy ends, so a tab opened halfway through would otherwise have
// nothing to show.
const liveLogs = new Map();

function makeLog(repo, id) {
    const lines = [];
    let bytes = 0;

    liveLogs.set(id, lines);

    return {
        write(line) {
            console.log(`${new Date().toISOString()} [${repo}] ${line}`);
            lines.push(line);
            bytes += line.length + 1;

            while (bytes > LOG_TAIL_BYTES && lines.length > 1) {
                bytes -= lines.shift().length + 1;
            }

            events.emit("event", { type: "log", id, repo, line });
        },
        text: () => lines.join("\n"),
    };
}

// git shells out to ssh, and docker compose to buildkit, so killing the direct
// child leaves the grandchild running and holding the stdio pipes open - the
// step would hang instead of stopping. On anything but Windows the child leads
// its own process group, and the whole group goes down together.
const GROUPED = process.platform !== "win32";

function killTree(child) {
    try {
        if (GROUPED) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
    } catch {
        // Already gone between the check and the signal.
    }
}

// No shell involved: arguments are passed as an array, so a repository or
// branch name can never be interpreted as a command.
function runStep(log, cwd, command, args, register) {
    return new Promise((resolve, reject) => {
        log.write(`$ ${command} ${args.join(" ")}`);

        const child = spawn(command, args, { cwd, shell: false, detached: GROUPED });
        let stopped = false;

        const stop = () => {
            stopped = true;
            killTree(child);
        };

        register(stop);

        const timer = setTimeout(() => {
            stop();
            reject(new Error(`${command} timed out after ${STEP_TIMEOUT_MS}ms`));
        }, STEP_TIMEOUT_MS);

        // `close` waits for every pipe to reach EOF, which a surviving
        // grandchild can delay indefinitely. Once we have killed the step, its
        // exit is enough to move on.
        child.on("exit", () => {
            if (!stopped) return;
            clearTimeout(timer);
            reject(new Error(`${command} was terminated`));
        });

        const pipe = (stream) => {
            stream.setEncoding("utf8");
            let buffer = "";
            stream.on("data", (chunk) => {
                buffer += chunk;
                const parts = buffer.split("\n");
                buffer = parts.pop();
                for (const line of parts) if (line.trim()) log.write(line);
            });
        };

        pipe(child.stdout);
        pipe(child.stderr);

        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`${command} exited with code ${code}`));
        });
    });
}

function buildSteps(repo, branch) {
    const compose = ["compose"];
    if (repo.compose_file) compose.push("-f", repo.compose_file);

    const steps = [
        ["git", ["fetch", "--prune", "origin"]],
        ["git", ["reset", "--hard", `origin/${branch}`]],
    ];

    if (repo.clean_untracked) steps.push(["git", ["clean", "-fd"]]);

    steps.push(["docker", [...compose, "up", "-d", "--build"]]);
    if (repo.prune_images) steps.push(["docker", ["image", "prune", "-f"]]);

    return steps;
}

async function runDeploy(entry, repo, branch, commitSha, source) {
    const id = deployments.start(repo.id, branch, commitSha, source);
    const log = makeLog(repo.name, id);
    const startedAt = Date.now();

    entry.deploymentId = id;
    events.emit("event", { type: "start", id, repo: repo.name, branch });

    let status = "success";
    let error = null;

    try {
        if (!fs.existsSync(`${repo.path}/.git`)) {
            throw new Error(`${repo.path} is not a git checkout`);
        }

        for (const [command, args] of buildSteps(repo, branch)) {
            await runStep(log, repo.path, command, args, (stop) => { entry.stop = stop; });
            entry.stop = null;
        }
    } catch (err) {
        // A cancelled step fails like any other, so the flag set by cancel() is
        // what tells the two apart.
        status = entry.cancelled ? "cancelled" : "failed";
        error = entry.cancelled ? "cancelled by an operator" : err.message;
    }

    const durationMs = Date.now() - startedAt;

    log.write(status === "success"
        ? `deployed in ${Math.round(durationMs / 1000)}s`
        : `${status.toUpperCase()}: ${error}`);

    deployments.finish(id, { status, error, log: log.text(), durationMs });
    deployments.prune(repo.id);

    entry.stop = null;
    entry.cancelled = false;
    entry.deploymentId = null;
    liveLogs.delete(id);

    events.emit("event", { type: "end", id, repo: repo.name, status, durationMs });
}

async function drain(repo, job) {
    const entry = queue.get(repo.name);
    let next = job;

    while (next) {
        await runDeploy(entry, repo, next.branch, next.commitSha, next.source);
        next = entry.pending;
        entry.pending = null;
    }

    queue.delete(repo.name);
}

function schedule(repo, { branch, commitSha = null, source = "webhook" }) {
    const entry = queue.get(repo.name);

    if (entry) {
        entry.pending = { branch, commitSha, source };
        return "queued";
    }

    queue.set(repo.name, { pending: null, stop: null, cancelled: false, deploymentId: null });
    void drain(repo, { branch, commitSha, source });

    return "started";
}

// SIGKILL rather than SIGTERM: the step is a git or docker CLI that may be
// waiting on the network, and a deploy the operator asked to stop should stop.
function cancel(name) {
    const entry = queue.get(name);
    if (!entry) return false;

    entry.cancelled = true;
    entry.pending = null;
    if (entry.stop) entry.stop();

    return true;
}

const running = () => [...queue.keys()];

const runningInfo = () => [...queue.entries()]
    .filter(([, entry]) => entry.deploymentId !== null)
    .map(([repo, entry]) => ({ repo, id: entry.deploymentId }));

const liveLog = (id) => liveLogs.get(id) || null;

module.exports = { schedule, cancel, running, runningInfo, liveLog, events };
