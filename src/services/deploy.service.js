const fs = require("node:fs");
const path = require("node:path");

const { STEP_TIMEOUT_MS, LOG_TAIL_BYTES, APP_NAME } = require("../config");
const { stream } = require("../lib/exec");
const { redact } = require("../lib/giturl");
const envfile = require("../lib/envfile");
const { publish } = require("../lib/bus");
const logger = require("../lib/logger");
const deploymentsRepo = require("../db/deployments.repo");
const projectsRepo = require("../db/projects.repo");
const projectEnv = require("../db/env.repo");

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

// A checkout that is not there yet is not an error when Nimbus2k knows where it
// comes from: the first deploy creates it.
const needsClone = (project) => !fs.existsSync(path.join(project.path, ".git"));

// Written at 0600: it holds whatever the stack needs to run, which is usually
// every credential the application has.
function writeEnvFile(project, variables) {
    const target = path.join(project.path, ".env");

    fs.writeFileSync(target, envfile.format(variables, {
        header: `Written by ${APP_NAME} for ${project.name}.\nEdit it in the UI — this file is rewritten on every deploy.`,
    }), { mode: 0o600 });

    try {
        fs.chmodSync(target, 0o600);
    } catch {
        // Windows and some bind mounts; the directory permissions still apply.
    }

    return `wrote ${target} (${variables.length} variables)`;
}

// git will happily sit waiting for a password or a host-key answer that nobody
// is there to type, and the step would hang until STEP_TIMEOUT_MS. Failing in a
// second with a readable message is worth far more than waiting fifteen minutes
// for the same outcome.
const GIT_ENV = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
};

// Named so the UI can show which phase a run is in rather than only its output.
function buildPlan(project, branch) {
    const compose = ["compose"];
    if (project.compose_file) compose.push("-f", project.compose_file);

    const plan = [];

    if (project.repo_url && needsClone(project)) {
        plan.push({
            name: "clone",
            command: "git",
            // `--` so a URL can never be read as an option, whatever slipped
            // past validation.
            args: ["clone", "--branch", branch, "--", project.repo_url, project.path],
            // The checkout does not exist yet, so the step runs in its parent.
            cwd: path.dirname(project.path),
            env: GIT_ENV,
        });
    }

    plan.push(
        { name: "fetch", command: "git", args: ["fetch", "--prune", "origin"], env: GIT_ENV },
        { name: "reset", command: "git", args: ["reset", "--hard", `origin/${branch}`] },
    );

    if (project.clean_untracked) {
        plan.push({ name: "clean", command: "git", args: ["clean", "-fd"] });
    }

    // After `clean`, which would delete an untracked .env, and before `build`,
    // which is what reads it. Nothing is written when the project has no
    // variables: an empty set means "this checkout manages its own .env".
    const variables = projectEnv.list(project.id);

    if (variables.length > 0) {
        plan.push({
            name: "env",
            // Only the names are ever described or logged; the values are the
            // whole point of keeping them out of the repository.
            describe: `write .env — ${variables.map((pair) => pair.key).join(", ")}`,
            run: () => writeEnvFile(project, variables),
        });
    }

    plan.push({ name: "build", command: "docker", args: [...compose, "up", "-d", "--build", "--remove-orphans"] });

    if (project.prune_images) {
        plan.push({ name: "prune", command: "docker", args: ["image", "prune", "-f"] });
    }

    return plan;
}

async function runStep(entry, logSink, cwd, step, index, total) {
    logSink.write(`── [${index + 1}/${total}] ${step.name}: ${step.describe || `${step.command} ${step.args.join(" ")}`}`);
    publish("step", { id: entry.deploymentId, step: step.name, index, total });

    // Not every step is a command: writing the .env is Nimbus2k's own work, and
    // belongs in the plan so it is visible and ordered like the rest.
    if (step.run) {
        const note = await step.run();
        if (note) logSink.write(note);
        return;
    }

    await stream(step.command, step.args, {
        // A clone runs in the parent of the checkout it is about to create.
        cwd: step.cwd || cwd,
        env: step.env,
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
        if (needsClone(project)) {
            if (!project.repo_url) {
                throw new Error(`${project.path} is not a git checkout, and this project has no repository URL to clone from`);
            }

            if (fs.existsSync(project.path) && fs.readdirSync(project.path).length > 0) {
                throw new Error(`${project.path} already exists and is not empty — move it aside, or point the project somewhere else`);
            }

            // `git clone` creates the checkout itself but not the tree above it.
            fs.mkdirSync(path.dirname(project.path), { recursive: true });
            sink.write(`⤓ cloning ${redact(project.repo_url)} into ${project.path}`);
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

module.exports = { schedule, cancel, isRunning, runningNames, active, liveLog, buildPlan, needsClone };
