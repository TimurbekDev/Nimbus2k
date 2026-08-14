const path = require("node:path");

const { APP_NAME } = require("../config");
const docker = require("./docker.service");
const projectsRepo = require("../db/projects.repo");
const { groups: groupsRepo, containerMeta } = require("../db/groups.repo");

// Marks a bucket that has no real identity behind it — "Standalone",
// "Ungrouped", "Not managed" — so those sort last and offer no bulk action.
// A colon cannot appear in a stack, group or project name, so a synthetic key
// can never collide with a real one.
const LOOSE = "::";

// How a container may be bucketed in the fleet view. `stack` is what docker
// itself knows, `group` is what the operator decided, and the rest are
// convenience axes for answering a specific question quickly.
const GROUP_BY = {
    stack: {
        label: "Compose stack",
        hint: "com.docker.compose.project",
        key: (container) => container.stack || LOOSE + "loose",
        title: (key) => (key === LOOSE + "loose" ? "Standalone containers" : key),
        icon: "layers",
    },
    group: {
        label: "Group",
        hint: "your own grouping",
        key: (container) => (container.group ? `g:${container.group.id}` : LOOSE + "ungrouped"),
        title: (key, sample) => (key === LOOSE + "ungrouped" ? "Ungrouped" : sample.group.name),
        icon: "folder",
    },
    project: {
        label: "Project",
        hint: "the repository that deploys it",
        key: (container) => (container.project ? `p:${container.project}` : LOOSE + "unmanaged"),
        title: (key, sample) => (key === LOOSE + "unmanaged" ? `Not managed by ${APP_NAME}` : sample.project),
        icon: "git",
    },
    state: {
        label: "State",
        hint: "running, exited, paused…",
        key: (container) => container.state || "unknown",
        title: (key) => key.charAt(0).toUpperCase() + key.slice(1),
        icon: "activity",
    },
    image: {
        label: "Image",
        hint: "same image, every replica",
        key: (container) => (container.image || "unknown").split(":")[0],
        title: (key) => key,
        icon: "box",
    },
    none: {
        label: "Flat list",
        hint: "no grouping",
        key: () => LOOSE + "all",
        title: () => "All containers",
        icon: "list",
    },
};

const SORT_BY = {
    name: (a, b) => a.name.localeCompare(b.name),
    state: (a, b) => stateRank(a) - stateRank(b) || a.name.localeCompare(b.name),
    cpu: (a, b) => (b.stats?.cpu || 0) - (a.stats?.cpu || 0),
    memory: (a, b) => (b.stats?.memPercent || 0) - (a.stats?.memPercent || 0),
    created: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
};

// Something wrong sorts first: an unhealthy or exited container is what an
// operator opened this page for.
const stateRank = (container) => {
    if (container.health === "unhealthy") return 0;
    if (container.state === "dead") return 1;
    if (container.state === "exited") return 2;
    if (container.state === "restarting") return 3;
    if (container.state === "paused") return 4;
    if (container.state === "created") return 5;
    return 6;
};

// A compose stack takes its name from the checkout directory unless the project
// overrides it, which is how a running container is tied back to the repository
// that deployed it.
function stackIndex() {
    const index = new Map();

    for (const project of projectsRepo.stackNames()) {
        const stack = project.stack || path.basename(project.path || "").toLowerCase();
        if (stack) index.set(stack, project.name);
    }

    return index;
}

/**
 * The one call every fleet view is built from: containers as docker reports
 * them, enriched with the operator's annotations and the project that owns
 * them, then filtered, sorted and bucketed.
 */
async function view({
    groupBy = "stack",
    sortBy = "state",
    search = "",
    state = "all",
    groupId = null,
    force = false,
} = {}) {
    const health = await docker.health();

    if (!health.ok) {
        return {
            ok: false,
            error: health.error,
            health,
            buckets: [],
            containers: [],
            totals: emptyTotals(),
            groupBy,
            sortBy,
        };
    }

    const raw = await docker.list({ force });
    const meta = containerMeta.all();
    const stacks = stackIndex();

    const containers = raw.map((container) => {
        const annotation = meta.get(container.name) || null;

        return {
            ...container,
            group: annotation?.group || null,
            pinned: annotation?.pinned || false,
            note: annotation?.note || null,
            project: container.stack ? stacks.get(container.stack.toLowerCase()) || null : null,
        };
    });

    const totals = summarise(containers);

    const needle = search.trim().toLowerCase();
    const filtered = containers.filter((container) => {
        if (state === "running" && !container.running) return false;
        if (state === "stopped" && container.running) return false;
        if (state === "unhealthy" && container.health !== "unhealthy") return false;
        if (groupId && container.group?.id !== groupId) return false;

        if (!needle) return true;

        return [
            container.name, container.image, container.stack, container.service,
            container.state, container.project, container.group?.name, container.note,
        ].some((field) => field && String(field).toLowerCase().includes(needle));
    });

    const axis = GROUP_BY[groupBy] || GROUP_BY.stack;
    const compare = SORT_BY[sortBy] || SORT_BY.state;

    const buckets = new Map();

    for (const container of filtered) {
        const key = axis.key(container);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(container);
    }

    const ordered = [...buckets.entries()]
        .map(([key, members]) => {
            members.sort((a, b) => Number(b.pinned) - Number(a.pinned) || compare(a, b));

            return {
                key,
                title: axis.title(key, members[0]),
                // A synthetic bucket ("Standalone", "Ungrouped") has no target
                // to act on as a whole; a real one does.
                loose: key.startsWith(LOOSE),
                stack: groupBy === "stack" && !key.startsWith(LOOSE) ? key : null,
                group: members[0].group && groupBy === "group" ? members[0].group : null,
                project: groupBy === "project" && !key.startsWith(LOOSE) ? members[0].project : null,
                containers: members,
                ...summarise(members),
            };
        })
        // Buckets with a problem float up, then the busiest, then alphabetical.
        .sort((a, b) => {
            if (a.loose !== b.loose) return a.loose ? 1 : -1;
            if ((b.unhealthy + b.stopped > 0) !== (a.unhealthy + a.stopped > 0)) {
                return (b.unhealthy + b.stopped) - (a.unhealthy + a.stopped);
            }
            return String(a.title).localeCompare(String(b.title));
        });

    return {
        ok: true,
        health,
        buckets: ordered,
        containers: filtered,
        totals,
        matched: filtered.length,
        groupBy,
        sortBy,
        axis: { ...axis, id: groupBy },
    };
}

const emptyTotals = () => ({ total: 0, running: 0, stopped: 0, paused: 0, unhealthy: 0, cpu: 0, memory: 0 });

function summarise(containers) {
    const totals = emptyTotals();

    for (const container of containers) {
        totals.total += 1;
        if (container.running) totals.running += 1;
        else if (container.state === "paused") totals.paused += 1;
        else totals.stopped += 1;

        if (container.health === "unhealthy") totals.unhealthy += 1;

        totals.cpu += container.stats?.cpu || 0;
        totals.memory += container.stats?.memPercent || 0;
    }

    totals.cpu = Math.round(totals.cpu * 10) / 10;
    totals.memory = Math.round(totals.memory * 10) / 10;

    return totals;
}

// The container names a bulk action should target. Resolved server-side so a
// form only ever posts the bucket, never a list a client could have edited.
async function membersOf({ stack = null, groupId = null, project = null, state = null }) {
    const containers = await docker.list({ withStats: false });
    const meta = containerMeta.all();
    const stacks = stackIndex();

    return containers
        .filter((container) => {
            if (stack && container.stack !== stack) return false;
            if (groupId && meta.get(container.name)?.group?.id !== groupId) return false;
            if (project && stacks.get((container.stack || "").toLowerCase()) !== project) return false;
            if (state === "running" && !container.running) return false;
            if (state === "stopped" && container.running) return false;
            return true;
        })
        .map((container) => container.name);
}

// Containers belonging to one project, for its detail page.
async function forProject(project) {
    const health = await docker.health();
    if (!health.ok) return { ok: false, error: health.error, containers: [], totals: emptyTotals() };

    const stack = project.stack || path.basename(project.path || "").toLowerCase();
    const containers = (await docker.list())
        .filter((container) => (container.stack || "").toLowerCase() === stack)
        .sort((a, b) => stateRank(a) - stateRank(b) || a.name.localeCompare(b.name));

    return { ok: true, stack, containers, totals: summarise(containers) };
}

// Which stacks exist right now but have no project registered - the fastest
// route from "this is running on the box" to "Nimbus can deploy it".
async function unmanagedStacks() {
    const health = await docker.health();
    if (!health.ok) return [];

    const known = stackIndex();
    const seen = new Map();

    for (const container of await docker.list({ withStats: false })) {
        if (!container.stack || known.has(container.stack.toLowerCase())) continue;

        const entry = seen.get(container.stack) || { stack: container.stack, containers: 0, workdir: container.workdir };
        entry.containers += 1;
        seen.set(container.stack, entry);
    }

    return [...seen.values()].sort((a, b) => b.containers - a.containers);
}

const groupOptions = () => groupsRepo.list();

module.exports = {
    view, membersOf, forProject, unmanagedStacks, groupOptions,
    GROUP_BY, SORT_BY, LOOSE, summarise,
};
