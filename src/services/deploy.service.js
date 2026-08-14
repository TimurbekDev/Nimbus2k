const fs = require("node:fs");
const path = require("node:path");

const { STEP_TIMEOUT_MS, LOG_TAIL_BYTES } = require("../config");
const { stream } = require("../lib/exec");
const { publish } = require("../lib/bus");
const logger = require("../lib/logger");
const deploymentsRepo = require("../db/deployments.repo");
const projectsRepo = require("../db/projects.repo");

const log = logger("deploy");

// One deploy per project at a time. Pushes arriving mid-deploy collapse into a
// single follow-up run instead of stacking up: three commits landing during a
// build should produce one more deploy, not three.
const queue = new Map();

// Lines of a run that has not finished yet. The database only receives the log
// when the deploy ends, so a tab opened halfway through would otherwise have
// nothing to show.
const liveLogs = new Map();

function makeLog(project, id) {
    const lines = [];
    let bytes = 0;

    liveLogs.set(id, lines);

    return {
        write(line) {
            lines.push(line);
            bytes += line.length + 1;

            // The tail is what matters when a build fails; the head is boilerplate.
            while (bytes > LOG_TAIL_BYTES && lines.length > 1) {
                bytes -= lines.shift().length + 1;
            }

            publish("log", { id, project, line });
        },
        text: () => lines.join("\n"),
    };
}

// ------------------------------------------------------------------ steps

// Named so the UI can show which phase a run is in rather than only its output.
function buildPlan(project, branch) {
    const compose = ["compose"];
    if (project.compose_file) compose.push("-f", project.compose_file);

    const plan = [
        { name: "fetch", command: "git", args: ["fetch", "--prune", "origin"] },
        { name: "reset", command: "git", args: ["reset", "--hard", `origin/${branch}`] },
    ];

    if (project.clean_untracked) {
        plan.push({ name: "clean", command: "git", args: ["clean", "-fd"] });
    }

    plan.push({ name: "build", command: "docker", args: [...compose, "up", "-d", "--build", "--remove-orphans"] });

    if (project.prune_images) {
        plan.push({ name: "prune", command: "docker", args: ["image", "prune", "-f"] });
    }

    return plan;
}

async function runStep(entry, logSink, cwd, step, index, total) {
    logSink.write(`── [${index + 1}/${total}] ${step.name}: ${step.command} ${step.args.join(" ")}`);
    publish("step", { id: entry.deploymentId, step: step.name, index, total });

    await stream(step.command, step.args, {
        cwd,
        timeoutMs: STEP_TIMEOUT_MS,
        onLine: (line) => logSink.write(line),
        register: (stop) => { entry.stop = stop; },
    });

    entry.stop = null;
}

// ------------------------------------------------------------------ run

async function runDeploy(entry, project, job) {
    const { branch, commitSha, trigger, actor } = job;
    const id = deploymentsRepo.start(project.id, { branch, commitSha, trigger, actor });
    const sink = makeLog(project.name, id);
    const startedAt = Date.now();

    entry.deploymentId = id;
    entry.startedAt = startedAt;
    entry.branch = branch;

    publish("deploy:start", { id, project: project.name, branch, trigger });
    log.info("deploy started", { id, project: project.name, branch, trigger });

    let status = "success";
    let error = null;

    try {
        if (!fs.existsSync(path.join(project.path, ".git"))) {
            throw new Error(`${project.path} is not a git checkout`);
        }

        const plan = buildPlan(project, branch);
        sink.write(`▶ ${project.name} · ${branch} · ${trigger}`);

        for (const [index, step] of plan.entries()) {
            await runStep(entry, sink, project.path, step, index, plan.length);
        }
    } catch (err) {
        // A cancelled step fails like any other, so the flag set by cancel() is
        // what tells the two apart.
        status = entry.cancelled ? "cancelled" : "failed";
        error = entry.cancelled ? "cancelled by an operator" : err.message;
    }

    const durationMs = Date.now() - startedAt;

    sink.write(status === "success"
        ? `✔ deployed in ${Math.round(durationMs / 1000)}s`
        : `✖ ${status.toUpperCase()}: ${error}`);

    deploymentsRepo.finish(id, { status, error, log: sink.text(), durationMs });
    deploymentsRepo.prune(project.id);

    // A successful build changes what is running, so the fleet view is stale
    // the moment this returns.
    if (status === "success") publish("containers", { reason: "deploy", project: project.name });

    entry.stop = null;
    entry.cancelled = false;
    entry.deploymentId = null;
    liveLogs.delete(id);

    publish("deploy:end", { id, project: project.name, status, durationMs, error });
    log[status === "success" ? "info" : "warn"]("deploy finished", {
        id, project: project.name, status, durationMs,
    });

    return { id, status, durationMs };
}

async function drain(project, job) {
    const entry = queue.get(project.name);
    let next = job;

    while (next) {
        // Settings may have changed between the queued push and this run.
        const fresh = projectsRepo.byName(project.name) || project;
        await runDeploy(entry, fresh, next);

        next = entry.pending;
        entry.pending = null;
    }

    queue.delete(project.name);
}

/**
 * Queues a deploy. Returns "started" when it begins immediately and "queued"
 * when it will follow the run already in flight.
 */
function schedule(project, { branch, commitSha = null, trigger = "webhook", actor = null }) {
    const job = { branch, commitSha, trigger, actor };
    const entry = queue.get(project.name);

    if (entry) {
        entry.pending = job;
        publish("deploy:queued", { project: project.name, branch });
        return "queued";
    }

    queue.set(project.name, {
        pending: null, stop: null, cancelled: false, deploymentId: null, startedAt: null, branch,
    });

    void drain(project, job);

    return "started";
}

// SIGKILL rather than SIGTERM: the step is a git or docker CLI that may be
// waiting on the network, and a deploy an operator asked to stop should stop.
function cancel(name) {
    const entry = queue.get(name);
    if (!entry) return false;

    entry.cancelled = true;
    entry.pending = null;
    if (entry.stop) entry.stop();

    return true;
}

const isRunning = (name) => queue.has(name);

const runningNames = () => [...queue.keys()];

const active = () => [...queue.entries()]
    .filter(([, entry]) => entry.deploymentId !== null)
    .map(([project, entry]) => ({
        project,
        id: entry.deploymentId,
        branch: entry.branch,
        startedAt: entry.startedAt,
        elapsedMs: Date.now() - entry.startedAt,
    }));

const liveLog = (id) => liveLogs.get(id) || null;

module.exports = { schedule, cancel, isRunning, runningNames, active, liveLog, buildPlan };
