const express = require("express");

const deployments = require("../../../db/deployments.repo");
const deploy = require("../../../services/deploy.service");
const v = require("../../../lib/validate");

const router = express.Router();

router.get("/", (req, res) => res.json({
    total: deployments.count({ project: req.query.project || null, status: req.query.status || null }),
    stats: deployments.stats(),
    items: deployments.list({
        project: req.query.project || null,
        status: req.query.status || null,
        limit: v.integer(req.query.limit, 20, { min: 1, max: 100 }),
        offset: v.integer(req.query.offset, 0, { min: 0 }),
    }),
}));

router.get("/:id", (req, res) => {
    const deployment = deployments.get(v.integer(req.params.id, -1));
    if (!deployment) return res.status(404).json({ error: "Not found" });

    res.json(deployment);
});

router.get("/:id/log", (req, res) => {
    const id = v.integer(req.params.id, -1);
    const deployment = deployments.get(id);
    if (!deployment) return res.status(404).json({ error: "Not found" });

    // A finished run has its log in the database; a running one only exists in
    // the deployer's buffer until it ends.
    const live = deployment.status === "running" ? deploy.liveLog(id) : null;
    res.type("text/plain").send(live ? live.join("\n") : (deployments.log(id) || ""));
});

module.exports = router;
