const path = require("node:path");
const express = require("express");

const { PROJECTS_DIR } = require("../config");
const { repos, deployments } = require("../db");
const { schedule, cancel, running } = require("../deployer");
const { requireAdmin } = require("../auth");
const { REPO_NAME } = require("../validate");

const router = express.Router();

// Scoped to these prefixes, not the whole router: mounted at the root, a bare
// `router.use(requireAdmin)` would answer 401 for every request in the app,
// including the UI and the webhook.
router.use(["/repos", "/deployments", "/status"], requireAdmin);

router.get("/status", (req, res) => res.json({
    running: running(),
    repos: repos.list().length,
    recent: deployments.list({ limit: 10 }),
}));

router.get("/repos", (req, res) => res.json(repos.list()));

router.post("/repos", (req, res) => {
    const { name, branch = "master", path: repoPath, ...rest } = req.body || {};

    if (typeof name !== "string" || !REPO_NAME.test(name)) {
        return res.status(400).json({ error: "Invalid repository name" });
    }

    if (repos.byName(name)) return res.status(409).json({ error: "Already registered" });

    const target = repoPath || path.join(PROJECTS_DIR, name);
    if (!path.isAbsolute(target)) return res.status(400).json({ error: "path must be absolute" });

    res.status(201).json(repos.create({ name, branch, path: target, ...rest }));
});

router.patch("/repos/:name", (req, res) => {
    if (!repos.byName(req.params.name)) return res.status(404).json({ error: "Not found" });
    res.json(repos.update(req.params.name, req.body || {}));
});

router.delete("/repos/:name", (req, res) => {
    if (!repos.remove(req.params.name)) return res.status(404).json({ error: "Not found" });
    res.status(204).end();
});

router.post("/repos/:name/deploy", (req, res) => {
    const repo = repos.byName(req.params.name);
    if (!repo) return res.status(404).json({ error: "Not found" });

    const branch = req.body?.branch || repo.branch;
    const state = schedule(repo, { branch, source: "manual" });

    res.status(202).json({ repo: repo.name, branch, state });
});

router.post("/repos/:name/cancel", (req, res) => {
    if (!repos.byName(req.params.name)) return res.status(404).json({ error: "Not found" });
    if (!cancel(req.params.name)) return res.status(409).json({ error: "Nothing running" });

    res.status(202).json({ repo: req.params.name, state: "cancelling" });
});

router.get("/deployments", (req, res) => res.json(deployments.list({
    repo: req.query.repo || null,
    limit: Math.min(Number(req.query.limit) || 20, 100),
})));

router.get("/deployments/:id", (req, res) => {
    const deployment = deployments.get(Number(req.params.id));
    if (!deployment) return res.status(404).json({ error: "Not found" });
    res.json(deployment);
});

module.exports = router;
