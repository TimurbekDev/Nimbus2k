const express = require("express");

const { locals } = require("../../middleware/locals");
const { requireSession } = require("../../middleware/auth");

const router = express.Router();

// Only the UI parses form bodies; the webhook stays on the JSON parser that
// captures rawBody for the HMAC check.
router.use(express.urlencoded({ extended: false, limit: "64kb" }));
router.use(locals);

// Reachable without a session.
router.use(require("./auth.ui"));

// Everything past this point requires one.
router.use(requireSession);

router.use(require("./events.ui"));
router.use(require("./pulse.ui"));
router.use(require("./palette.ui"));
router.use(require("./overview.ui"));
router.use("/projects", require("./projects.ui"));
router.use("/containers", require("./containers.ui"));
router.use("/groups", require("./groups.ui"));
router.use("/deployments", require("./deployments.ui"));
router.use("/settings", require("./settings.ui"));

module.exports = router;
