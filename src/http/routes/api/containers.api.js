const express = require("express");

const docker = require("../../../services/docker.service");
const fleet = require("../../../services/fleet.service");
const { containerMeta } = require("../../../db/groups.repo");
const { audit } = require("../../../db/audit.repo");
const v = require("../../../lib/validate");

const router = express.Router();

router.get("/", async (req, res) => {
    const view = await fleet.view({
        groupBy: v.oneOf(req.query.by, Object.keys(fleet.GROUP_BY), "stack"),
        sortBy: v.oneOf(req.query.sort, Object.keys(fleet.SORT_BY), "state"),
        state: v.oneOf(req.query.state, ["all", "running", "stopped", "unhealthy"], "all"),
        search: v.text(req.query.q),
        force: req.query.fresh === "1",
    });

    if (!view.ok) return res.status(503).json({ error: view.error, docker: view.health });

    // Both shapes in one answer: a flat list for a script, the buckets for
    // anything drawing the same grouping the UI shows.
    res.json({
        totals: view.totals,
        groupBy: view.groupBy,
        groups: view.buckets.map(({ containers, ...bucket }) => ({
            ...bucket,
            containers: containers.map((item) => item.name),
        })),
        containers: view.containers,
    });
});

router.get("/:ref", async (req, res, next) => {
    try {
        const container = await docker.byRef(req.params.ref);
        if (!container) return res.status(404).json({ error: "Not found" });

        res.json({ ...container, detail: await docker.inspect(container.id) });
    } catch (err) {
        next(err);
    }
});

router.get("/:ref/logs", async (req, res, next) => {
    try {
        res.type("text/plain").send(await docker.logs(req.params.ref, {
            tail: v.integer(req.query.tail, 500, { min: 10, max: 20000 }),
            timestamps: req.query.timestamps === "1",
        }));
    } catch (err) {
        next(err);
    }
});

router.patch("/:ref", (req, res, next) => {
    const { ref } = req.params;
    if (!v.CONTAINER_REF.test(ref)) return next(new v.ValidationError("Invalid container reference", "ref"));

    const patch = {};
    if (req.body?.group_id !== undefined) patch.group_id = req.body.group_id || null;
    if (req.body?.pinned !== undefined) patch.pinned = Boolean(req.body.pinned);
    if (req.body?.note !== undefined) patch.note = String(req.body.note).slice(0, 280) || null;

    containerMeta.set(ref, patch);
    res.json({ ref, ...patch });
});

// Deliberately last: a literal action name would otherwise be read as a ref.
router.post("/:ref/:action", async (req, res, next) => {
    const { ref, action } = req.params;

    try {
        const result = await docker.act(ref, action);
        audit.record({ action: `container.${action}`, target: ref, actor: "api", ip: req.ip });
        res.status(202).json(result);
    } catch (err) {
        audit.record({ action: `container.${action}`, target: ref, detail: err.message, actor: "api", ip: req.ip, ok: false });
        next(err);
    }
});

module.exports = router;
