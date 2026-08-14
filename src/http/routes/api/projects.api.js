const path = require("node:path");
const express = require("express");

const { PROJECTS_DIR } = require("../../../config");
const projects = require("../../../db/projects.repo");
const deployments = require("../../../db/deployments.repo");
const deploy = require("../../../services/deploy.service");
const { audit } = require("../../../db/audit.repo");
const v = require("../../../lib/validate");

const router = express.Router();

const find = (req, res) => {
    const project = projects.byName(req.params.name);
    if (!project) res.status(404).json({ error: "Not found" });
    return project;
};

router.get("/", (req, res) => res.json(projects.listWithLast()));

router.post("/", (req, res) => {
    const { name, branch = "main", path: checkout, ...rest } = req.body || {};

    if (typeof name !== "string" || !v.PROJECT_NAME.test(name)) {
        return res.status(400).json({ error: "Invalid project name" });
    }

    if (projects.byName(name)) return res.status(409).json({ error: "Already registered" });

    const target = checkout || path.join(PROJECTS_DIR, name);
    if (!path.isAbsolute(target)) return res.status(400).json({ error: "path must be absolute" });

    const created = projects.create({ name, branch, path: target, ...rest });
    audit.record({ action: "project.create", target: name, actor: "api", ip: req.ip });

    res.status(201).json(created);
});

router.get("/:name", (req, res) => {
    const project = find(req, res);
    if (!project) return;

    res.json({ ...project, history: deployments.list({ project: project.name, limit: 20 }) });
});

router.patch("/:name", (req, res) => {
    const project = find(req, res);
    if (!project) return;

    audit.record({ action: "project.update", target: project.name, actor: "api", ip: req.ip });
    res.json(projects.update(project.name, req.body || {}));
});

router.delete("/:name", (req, res) => {
    if (!projects.remove(req.params.name)) return res.status(404).json({ error: "Not found" });

    audit.record({ action: "project.delete", target: req.params.name, actor: "api", ip: req.ip });
    res.status(204).end();
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
