const express = require("express");

const { PROJECTS_DIR } = require("../../../config");
const projects = require("../../../db/projects.repo");
const deployments = require("../../../db/deployments.repo");
const { webhookEvents } = require("../../../db/audit.repo");
const deploy = require("../../../services/deploy.service");
const fleet = require("../../../services/fleet.service");
const docker = require("../../../services/docker.service");

const router = express.Router();

router.get("/", async (req, res) => {
    const active = deploy.active();
    const rows = projects.listWithLast();

    // The overview should still render when the docker socket is missing; the
    // fleet card then explains itself instead of taking the page down.
    const [fleetView, usage, unmanaged] = await Promise.all([
        fleet.view({ groupBy: "stack", sortBy: "state" }).catch((err) => ({ ok: false, error: err.message, buckets: [], totals: null })),
        docker.systemUsage().catch(() => ({ ok: false })),
        fleet.unmanagedStacks().catch(() => []),
    ]);

    const attention = rows.filter((project) => project.last_status === "failed" || !project.enabled);

    res.render("pages/overview", {
        title: "Overview",
        nav: "overview",
        projects: rows,
        active,
        activeNames: active.map((item) => item.project),
        stats: deployments.stats(),
        activity: deployments.activity(14),
        recent: deployments.list({ limit: 8 }),
        deliveries: webhookEvents.list({ limit: 6 }),
        fleet: fleetView,
        usage,
        unmanaged: unmanaged.slice(0, 4),
        attention,
        projectsDir: PROJECTS_DIR,
    });
});

module.exports = router;
