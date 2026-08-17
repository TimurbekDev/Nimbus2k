const { all, get, run } = require("./index");

// A row read back from sqlite carries integers where the rest of the app wants
// booleans, and a joined group arrives as three loose columns.
const hydrate = (row) => row && {
    ...row,
    enabled: Boolean(row.enabled),
    prune_images: Boolean(row.prune_images),
    clean_untracked: Boolean(row.clean_untracked),
    auto_deploy: Boolean(row.auto_deploy),
    pinned: Boolean(row.pinned),
    group: row.group_id ? { id: row.group_id, name: row.group_name, color: row.group_color } : null,
};

const WRITABLE = [
    "branch", "path", "compose_file", "enabled", "prune_images", "clean_untracked",
    "description", "group_id", "auto_deploy", "pinned", "stack",
];

const SELECT = `
    SELECT p.*, g.name AS group_name, g.color AS group_color
    FROM projects p
    LEFT JOIN groups g ON g.id = p.group_id
`;

const projects = {
    byName: (name) => hydrate(get(`${SELECT} WHERE p.name = ?`, name)),

    byId: (id) => hydrate(get(`${SELECT} WHERE p.id = ?`, id)),

    list: () => all(`${SELECT} ORDER BY p.pinned DESC, p.name`).map(hydrate),

    count: () => get("SELECT COUNT(*) AS n FROM projects").n,

    // Changes on every edit, registration or removal; the client uses it to
    // decide whether a page is worth re-fetching.
    watermark: () => get(`
        SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS at FROM projects
    `),

    // The dashboard shows how each project last fared, which is one query
    // rather than one per row.
    listWithLast: () => all(`
        SELECT p.*, g.name AS group_name, g.color AS group_color,
               d.id AS last_id, d.status AS last_status, d.branch AS last_branch,
               d.started_at AS last_started_at, d.duration_ms AS last_duration_ms,
               d.commit_sha AS last_commit_sha,
               (SELECT COUNT(*) FROM deployments x WHERE x.repo_id = p.id) AS deploy_count,
               (SELECT COUNT(*) FROM deployments x WHERE x.repo_id = p.id AND x.status = 'failed') AS fail_count
        FROM projects p
        LEFT JOIN groups g ON g.id = p.group_id
        LEFT JOIN deployments d ON d.id = (SELECT MAX(id) FROM deployments WHERE repo_id = p.id)
        ORDER BY p.pinned DESC, p.name
    `).map(hydrate),

    create({
        name,
        branch = "main",
        path: checkout,
        compose_file = null,
        prune_images = true,
        clean_untracked = false,
        description = null,
        group_id = null,
    }) {
        run(`
            INSERT INTO projects (name, branch, path, compose_file, prune_images,
                                  clean_untracked, description, group_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, name, branch, checkout, compose_file, prune_images ? 1 : 0,
            clean_untracked ? 1 : 0, description, group_id);

        return projects.byName(name);
    },

    update(name, patch) {
        const columns = [];
        const values = [];

        for (const field of WRITABLE) {
            if (patch[field] === undefined) continue;
            columns.push(`${field} = ?`);
            values.push(typeof patch[field] === "boolean" ? Number(patch[field]) : patch[field]);
        }

        if (columns.length === 0) return projects.byName(name);

        values.push(name);
        run(`UPDATE projects SET ${columns.join(", ")}, updated_at = datetime('now') WHERE name = ?`, ...values);

        return projects.byName(name);
    },

    remove: (name) => run("DELETE FROM projects WHERE name = ?", name).changes > 0,

    // Every project in a group, used by the group-wide deploy action.
    inGroup: (groupId) => all(`${SELECT} WHERE p.group_id = ? ORDER BY p.name`, groupId).map(hydrate),

    // The compose project name a checkout produces defaults to the directory
    // name, which is how a running container is matched back to its project.
    stackNames: () => all("SELECT name, path, stack FROM projects"),
};

module.exports = projects;
