const express = require("express");

const deploymentsRepo = require("../../../db/deployments.repo");
const projects = require("../../../db/projects.repo");
const deploy = require("../../../services/deploy.service");
const { audit } = require("../../../db/audit.repo");
const v = require("../../../lib/validate");
const { sameOrigin } = require("../../middleware/auth");
const { safeBack } = require("../../middleware/locals");

const router = express.Router();

const encode = encodeURIComponent;
const PAGE_SIZE = 40;

router.get("/", (req, res) => {
    const status = v.oneOf(req.query.status, ["success", "failed", "cancelled", "running"], null);
    const project = v.optional(req.query.project, "project", v.PROJECT_NAME);
    const page = v.integer(req.query.page, 1, { min: 1, max: 500 });

    const total = deploymentsRepo.count({ project, status });
    const rows = deploymentsRepo.list({
        project, status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
    });

    res.render("pages/deployments", {
        title: "Deployments",
        nav: "deployments",
        deployments: rows,
        stats: deploymentsRepo.stats(),
        activity: deploymentsRepo.activity(30),
        projects: projects.list(),
        filters: { status, project, page },
        total,
        pages: Math.max(Math.ceil(total / PAGE_SIZE), 1),
    });
});

router.get("/:id", (req, res, next) => {
    const id = v.integer(req.params.id, null);
    const deployment = id && deploymentsRepo.get(id);
    if (!deployment) return next();

    // A finished run has its log in the database; a running one only exists in
    // the deployer's buffer until it ends.
    const live = deployment.status === "running" ? deploy.liveLog(id) : null;

    res.render("pages/deployment", {
        title: `#${deployment.id} · ${deployment.project}`,
        nav: "deployments",
        deployment,
        log: live ? live.join("\n") : (deploymentsRepo.log(id) || ""),
        neighbours: deploymentsRepo.list({ project: deployment.project, limit: 12 }),
    });
});

router.get("/:id/raw", (req, res, next) => {
    const id = v.integer(req.params.id, null);
    const deployment = id && deploymentsRepo.get(id);
    if (!deployment) return next();

    const live = deployment.status === "running" ? deploy.liveLog(id) : null;
    res.type("text/plain").send(live ? live.join("\n") : (deploymentsRepo.log(id) || ""));
});

router.post("/:id/redeploy", sameOrigin, (req, res, next) => {
    const id = v.integer(req.params.id, null);
    const deployment = id && deploymentsRepo.get(id);
    if (!deployment) return next();

    const project = projects.byName(deployment.project);
    if (!project) return next();

    const state = deploy.schedule(project, {
        branch: deployment.branch, trigger: "manual", actor: "ui",
    });

    audit.record({ action: "deployment.redeploy", target: project.name, detail: `#${id}`, actor: "ui", ip: req.ip });

    const back = safeBack(req.body?.back, `/ui/projects/${encode(project.name)}`);
    res.redirect(`${back}?msg=${state === "queued" ? "queued" : "deployed"}`);
});

module.exports = router;
