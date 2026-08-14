const express = require("express");

const { groups } = require("../../../db/groups.repo");
const projects = require("../../../db/projects.repo");
const { audit } = require("../../../db/audit.repo");
const v = require("../../../lib/validate");

const router = express.Router();

router.get("/", (req, res) => res.json(groups.list()));

router.post("/", (req, res, next) => {
    const name = v.text(req.body?.name);
    if (!v.GROUP_NAME.test(name)) return next(new v.ValidationError("Invalid group name", "name"));
    if (groups.byName(name)) return res.status(409).json({ error: "Already exists" });

    const group = groups.create({
        name,
        color: v.oneOf(req.body?.color, v.GROUP_COLORS, "slate"),
        description: v.text(req.body?.description) || null,
    });

    audit.record({ action: "group.create", target: name, actor: "api", ip: req.ip });
    res.status(201).json(group);
});

router.get("/:id", (req, res) => {
    const id = v.integer(req.params.id, -1);
    const group = groups.byId(id);
    if (!group) return res.status(404).json({ error: "Not found" });

    res.json({ ...group, projects: projects.inGroup(id) });
});

router.patch("/:id", (req, res) => {
    const id = v.integer(req.params.id, -1);
    if (!groups.byId(id)) return res.status(404).json({ error: "Not found" });

    res.json(groups.update(id, {
        name: req.body?.name,
        color: req.body?.color === undefined ? undefined : v.oneOf(req.body.color, v.GROUP_COLORS, "slate"),
        description: req.body?.description,
    }));
});

router.delete("/:id", (req, res) => {
    if (!groups.remove(v.integer(req.params.id, -1))) return res.status(404).json({ error: "Not found" });

    audit.record({ action: "group.delete", target: req.params.id, actor: "api", ip: req.ip });
    res.status(204).end();
});

module.exports = router;
