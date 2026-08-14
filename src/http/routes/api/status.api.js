const express = require("express");

const config = require("../../../config");
const projects = require("../../../db/projects.repo");
const deployments = require("../../../db/deployments.repo");
const deploy = require("../../../services/deploy.service");
const docker = require("../../../services/docker.service");
const fleet = require("../../../services/fleet.service");

const router = express.Router();

router.get("/status", (req, res) => res.json({
    name: config.APP_NAME,
    version: config.VERSION,
    uptimeMs: Math.round(process.uptime() * 1000),
    projects: projects.count(),
    running: deploy.active(),
    stats: deployments.stats(),
}));

router.get("/system", async (req, res) => {
    const [health, usage, info, view] = await Promise.all([
        docker.health(),
        docker.systemUsage(),
        docker.daemonInfo(),
        fleet.view({ groupBy: "stack" }).catch(() => ({ ok: false, totals: null })),
    ]);

    res.json({
        docker: health,
        daemon: info,
        usage,
        fleet: view.ok ? view.totals : null,
        node: process.version,
        version: config.VERSION,
    });
});

module.exports = router;
