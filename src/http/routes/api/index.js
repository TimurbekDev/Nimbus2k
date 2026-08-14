const express = require("express");

const { requireApiToken } = require("../../middleware/auth");
const config = require("../../../config");

const router = express.Router();

// A version prefix from the start: the UI is free to change every release, the
// API is what other machines depend on.
router.use(requireApiToken);

router.get("/", (req, res) => res.json({
    name: config.APP_NAME,
    version: config.VERSION,
    endpoints: [
        "GET    /api/v1/status",
        "GET    /api/v1/projects",
        "POST   /api/v1/projects",
        "GET    /api/v1/projects/:name",
        "PATCH  /api/v1/projects/:name",
        "DELETE /api/v1/projects/:name",
        "POST   /api/v1/projects/:name/deploy",
        "POST   /api/v1/projects/:name/cancel",
        "GET    /api/v1/deployments",
        "GET    /api/v1/deployments/:id",
        "GET    /api/v1/deployments/:id/log",
        "GET    /api/v1/containers",
        "GET    /api/v1/containers/:ref",
        "GET    /api/v1/containers/:ref/logs",
        "POST   /api/v1/containers/:ref/:action",
        "GET    /api/v1/groups",
        "POST   /api/v1/groups",
        "DELETE /api/v1/groups/:id",
        "GET    /api/v1/system",
    ],
}));

router.use(require("./status.api"));
router.use("/projects", require("./projects.api"));
router.use("/deployments", require("./deployments.api"));
router.use("/containers", require("./containers.api"));
router.use("/groups", require("./groups.api"));

module.exports = router;
