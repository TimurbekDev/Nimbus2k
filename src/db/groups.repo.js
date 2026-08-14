const { all, get, run } = require("./index");

// A group is the operator's own organising layer: it spans projects and
// containers alike, which is the part docker's compose labels cannot express -
// a stack is one compose file, a group can be "everything the billing team
// owns".
const groups = {
    list: () => all(`
        SELECT g.*,
               (SELECT COUNT(*) FROM projects p WHERE p.group_id = g.id) AS project_count,
               (SELECT COUNT(*) FROM container_meta c WHERE c.group_id = g.id) AS container_count
        FROM groups g
        ORDER BY g.sort_order, g.name
    `),

    byId: (id) => get("SELECT * FROM groups WHERE id = ?", id),

    byName: (name) => get("SELECT * FROM groups WHERE name = ?", name),

    create({ name, color = "slate", description = null }) {
        const { lastInsertRowid } = run(`
            INSERT INTO groups (name, color, description,
                                sort_order)
            VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM groups))
        `, name, color, description);

        return groups.byId(Number(lastInsertRowid));
    },

    update(id, { name, color, description }) {
        const columns = [];
        const values = [];

        if (name !== undefined) { columns.push("name = ?"); values.push(name); }
        if (color !== undefined) { columns.push("color = ?"); values.push(color); }
        if (description !== undefined) { columns.push("description = ?"); values.push(description); }

        if (columns.length === 0) return groups.byId(id);

        values.push(id);
        run(`UPDATE groups SET ${columns.join(", ")} WHERE id = ?`, ...values);

        return groups.byId(id);
    },

    // Members are detached rather than deleted: the foreign keys are ON DELETE
    // SET NULL, so removing a group never removes a project.
    remove: (id) => run("DELETE FROM groups WHERE id = ?", id).changes > 0,

    reorder(ids) {
        ids.forEach((id, index) => run("UPDATE groups SET sort_order = ? WHERE id = ?", index, id));
    },
};

// ------------------------------------------------------------------ containers

// Only the annotation lives here. Everything else about a container comes from
// the docker daemon on every request, because that is the only source that can
// be right.
const containerMeta = {
    all() {
        const rows = all(`
            SELECT c.name, c.group_id, c.pinned, c.note, g.name AS group_name, g.color AS group_color
            FROM container_meta c
            LEFT JOIN groups g ON g.id = c.group_id
        `);

        return new Map(rows.map((row) => [row.name, {
            ...row,
            pinned: Boolean(row.pinned),
            group: row.group_id ? { id: row.group_id, name: row.group_name, color: row.group_color } : null,
        }]));
    },

    set(name, patch) {
        const existing = get("SELECT name FROM container_meta WHERE name = ?", name);

        if (!existing) {
            run(`
                INSERT INTO container_meta (name, group_id, pinned, note)
                VALUES (?, ?, ?, ?)
            `, name, patch.group_id ?? null, patch.pinned ? 1 : 0, patch.note ?? null);
            return;
        }

        const columns = [];
        const values = [];

        if (patch.group_id !== undefined) { columns.push("group_id = ?"); values.push(patch.group_id); }
        if (patch.pinned !== undefined) { columns.push("pinned = ?"); values.push(patch.pinned ? 1 : 0); }
        if (patch.note !== undefined) { columns.push("note = ?"); values.push(patch.note); }

        if (columns.length === 0) return;

        values.push(name);
        run(`UPDATE container_meta SET ${columns.join(", ")}, updated_at = datetime('now') WHERE name = ?`, ...values);
    },

    inGroup: (groupId) => all("SELECT name FROM container_meta WHERE group_id = ?", groupId).map((row) => row.name),

    clear: (name) => run("DELETE FROM container_meta WHERE name = ?", name),
};

module.exports = { groups, containerMeta };
