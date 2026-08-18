const path = require("node:path");
const express = require("express");

const { PROJECTS_DIR } = require("../../../config");
const projects = require("../../../db/projects.repo");
const deployments = require("../../../db/deployments.repo");
const deploy = require("../../../services/deploy.service");
const { audit } = require("../../../db/audit.repo");
const v = require("../../../lib/validate");
const giturl = require("../../../lib/giturl");
const envfile = require("../../../lib/envfile");
const projectEnv = require("../../../db/env.repo");

const router = express.Router();

const find = (req, res) => {
    const project = projects.byName(req.params.name);
    if (!project) res.status(404).json({ error: "Not found" });
    return project;
};

router.get("/", (req, res) => res.json(projects.listWithLast()));

/**
 * Register a project. Given `repo_url`, the name comes from it, the checkout is
 * cloned by the deploy this schedules, and the response carries the id of that
 * run so a caller can follow the log.
 */
router.post("/", (req, res, next) => {
    const body = req.body || {};
    const branch = body.branch || "main";

    if (!v.BRANCH_NAME.test(branch)) return res.status(400).json({ error: "Invalid branch" });

    let name = body.name;
    let repoUrl = null;

    if (body.repo_url) {
        let parsed;
        try {
            parsed = giturl.parse(body.repo_url);
        } catch (err) {
            return next(err);
        }

        repoUrl = parsed.url;
        name = parsed.name;
    }

    if (typeof name !== "string" || !v.PROJECT_NAME.test(name)) {
        return res.status(400).json({ error: "Invalid project name" });
    }

    if (projects.byName(name)) return res.status(409).json({ error: "Already registered" });

    const parent = body.path || PROJECTS_DIR;
    if (!path.isAbsolute(parent)) return res.status(400).json({ error: "path must be absolute" });

    const target = path.basename(parent) === name ? parent : path.join(parent, name);

    const created = projects.create({
        name,
        branch,
        path: target,
        repo_url: repoUrl,
        compose_file: body.compose_file ?? null,
        description: body.description ?? null,
        group_id: body.group_id ?? null,
        prune_images: body.prune_images ?? true,
        clean_untracked: body.clean_untracked ?? false,
        safe_deploy: body.safe_deploy ?? true,
        health_timeout: v.integer(body.health_timeout, 90, { min: 10, max: 3600 }),
    });

    // `env` is an object rather than a list: `{ "PORT": "8080" }` is what a
    // caller already has, and order does not matter to a .env file.
    if (body.env) {
        let variables;
        try {
            variables = envfile.checkAll(Object.entries(body.env).map(([key, value]) => ({ key, value: String(value) })));
        } catch (err) {
            projects.remove(name);
            return next(err);
        }

        projectEnv.replace(created.id, variables);
    }

    audit.record({
        action: "project.create",
        target: name,
        detail: repoUrl ? giturl.redact(repoUrl) : target,
        actor: "api",
        ip: req.ip,
    });

    // A project registered by URL has nothing on disk yet, so registering it
    // and deploying it are the same request.
    const deploying = Boolean(repoUrl) && body.deploy !== false;
    if (deploying) deploy.schedule(created, { branch, trigger: "manual", actor: "api" });

    res.status(201).json({ ...created, deploying });
});

router.get("/:name", (req, res) => {
    const project = find(req, res);
    if (!project) return;

    res.json({ ...project, history: deployments.list({ project: project.name, limit: 20 }) });
});

router.patch("/:name", (req, res, next) => {
    const project = find(req, res);
    if (!project) return;

    const patch = { ...(req.body || {}) };

    // The one field that becomes a git argument, so it is parsed rather than
    // stored as given. An explicit null clears it.
    if (patch.repo_url) {
        try {
            patch.repo_url = giturl.parse(patch.repo_url).url;
        } catch (err) {
            return next(err);
        }
    }

    // The one numeric setting, and the one a caller can send as anything.
    if (patch.health_timeout !== undefined) {
        patch.health_timeout = v.integer(patch.health_timeout, project.health_timeout, { min: 10, max: 3600 });
    }

    audit.record({ action: "project.update", target: project.name, actor: "api", ip: req.ip });
    res.json(projects.update(project.name, patch));
});

router.delete("/:name", (req, res) => {
    if (!projects.remove(req.params.name)) return res.status(404).json({ error: "Not found" });

    deploy.forget(req.params.name);

    audit.record({ action: "project.delete", target: req.params.name, actor: "api", ip: req.ip });
    res.status(204).end();
});

// The values a project's compose stack reads. Written into the checkout's .env
// by the next deploy, never before: the checkout may not exist yet.
router.get("/:name/env", (req, res) => {
    const project = find(req, res);
    if (!project) return;

    res.json(Object.fromEntries(projectEnv.list(project.id).map((pair) => [pair.key, pair.value])));
});

router.put("/:name/env", (req, res, next) => {
    const project = find(req, res);
    if (!project) return;

    let variables;
    try {
        variables = envfile.checkAll(Object.entries(req.body || {}).map(([key, value]) => ({ key, value: String(value) })));
    } catch (err) {
        return next(err);
    }

    projectEnv.replace(project.id, variables);
    audit.record({
        action: "project.env",
        target: project.name,
        detail: variables.map((pair) => pair.key).join(", ") || "(cleared)",
        actor: "api",
        ip: req.ip,
    });

    res.json({ project: project.name, variables: variables.length });
});

router.post("/:name/deploy", (req, res) => {
    const project = find(req, res);
    if (!project) return;

    const branch = req.body?.branch || project.branch;
    if (!v.BRANCH_NAME.test(branch)) return res.status(400).json({ error: "Invalid branch" });

    const state = deploy.schedule(project, { branch, trigger: "manual", actor: "api" });
    audit.record({ action: "project.deploy", target: project.name, detail: branch, actor: "api", ip: req.ip });

    res.status(202).json({ project: project.name, branch, state });
});

router.post("/:name/cancel", (req, res) => {
    const project = find(req, res);
    if (!project) return;

    if (!deploy.cancel(project.name)) return res.status(409).json({ error: "Nothing running" });

    audit.record({ action: "project.cancel", target: project.name, actor: "api", ip: req.ip });
    res.status(202).json({ project: project.name, state: "cancelling" });
});

module.exports = router;
