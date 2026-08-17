const { all, run, transaction } = require("./index");

// The values a project's compose file expects, kept per project and written out
// as one .env in the checkout at deploy time.
const projectEnv = {
    list: (projectId) => all(
        "SELECT key, value FROM project_env WHERE project_id = ? ORDER BY position, key",
        projectId,
    ),

    count: (projectId) => all(
        "SELECT 1 FROM project_env WHERE project_id = ?",
        projectId,
    ).length,

    /**
     * Replaces the whole set in one transaction. The editor always posts every
     * row, so a partial write - half the old values and half the new - is the
     * one outcome worth ruling out.
     */
    replace(projectId, pairs) {
        transaction(() => {
            run("DELETE FROM project_env WHERE project_id = ?", projectId);

            pairs.forEach((pair, index) => {
                run(
                    "INSERT INTO project_env (project_id, key, value, position) VALUES (?, ?, ?, ?)",
                    projectId, pair.key, pair.value, index,
                );
            });
        });

        return projectEnv.list(projectId);
    },

    // How many variables each project has, for the list pages; one query rather
    // than one per row.
    counts() {
        const rows = all("SELECT project_id, COUNT(*) AS n FROM project_env GROUP BY project_id");
        return new Map(rows.map((row) => [row.project_id, row.n]));
    },
};

module.exports = projectEnv;
