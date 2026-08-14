const express = require("express");

const projects = require("../../../db/projects.repo");
const { groups } = require("../../../db/groups.repo");
const fleet = require("../../../services/fleet.service");

const router = express.Router();

const encode = encodeURIComponent;

// The command palette's index. Fetched rather than rendered into the page
// because projects and containers change while a tab is open, and because the
// palette is opened on demand rather than on every page load.
router.get("/palette.json", async (req, res) => {
    const items = [];

    for (const project of projects.list()) {
        items.push({
            group: "Projects",
            label: project.name,
            meta: project.branch,
            icon: "git",
            href: `/ui/projects/${encode(project.name)}`,
        });
    }

    for (const group of groups.list()) {
        items.push({
            group: "Groups",
            label: group.name,
            meta: `${group.project_count + group.container_count} members`,
            icon: "folder",
            href: `/ui/containers?by=group&group=${group.id}`,
        });
    }

    // The daemon may be unreachable; the rest of the palette still works.
    const view = await fleet.view({ groupBy: "none", sortBy: "name" }).catch(() => ({ ok: false }));

    if (view.ok) {
        for (const container of view.containers) {
            items.push({
                group: "Containers",
                label: container.name,
                meta: container.state,
                icon: "box",
                href: `/ui/containers/${encode(container.name)}`,
            });
        }

        const stacks = [...new Set(view.containers.map((item) => item.stack).filter(Boolean))];
        for (const stack of stacks) {
            items.push({
                group: "Stacks",
                label: stack,
                meta: "compose stack",
                icon: "layers",
                href: `/ui/containers?by=stack&q=${encode(stack)}`,
            });
        }
    }

    res.set("Cache-Control", "no-store").json({ items });
});

module.exports = router;
