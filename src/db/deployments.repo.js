const { all, get, run } = require("./index");
const { DEPLOYMENT_HISTORY } = require("../config");

const SELECT = `
    SELECT d.id, d.repo_id, p.name AS project, d.branch, d.commit_sha, d.trigger,
           d.actor, d.status, d.error, d.started_at, d.finished_at, d.duration_ms
    FROM deployments d
    JOIN projects p ON p.id = d.repo_id
`;

const deployments = {
    start(projectId, { branch, commitSha = null, trigger = "webhook", actor = null }) {
        const { lastInsertRowid } = run(`
            INSERT INTO deployments (repo_id, branch, commit_sha, trigger, actor, status)
            VALUES (?, ?, ?, ?, ?, 'running')
        `, projectId, branch, commitSha, trigger, actor);

        return Number(lastInsertRowid);
    },

    finish(id, { status, error = null, log = null, durationMs }) {
        run(`
            UPDATE deployments
            SET status = ?, error = ?, log = ?, finished_at = datetime('now'), duration_ms = ?
            WHERE id = ?
        `, status, error, log, durationMs, id);
    },

    // Called after a deploy finishes so old logs do not grow the file forever.
    prune(projectId) {
        run(`
            DELETE FROM deployments
            WHERE repo_id = ?
              AND id NOT IN (SELECT id FROM deployments WHERE repo_id = ? ORDER BY id DESC LIMIT ?)
        `, projectId, projectId, DEPLOYMENT_HISTORY);
    },

    list({ project = null, status = null, limit = 20, offset = 0 } = {}) {
        const where = [];
        const params = [];

        if (project) {
            where.push("p.name = ?");
            params.push(project);
        }

        if (status) {
            where.push("d.status = ?");
            params.push(status);
        }

        const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        params.push(limit, offset);

        return all(`${SELECT} ${clause} ORDER BY d.id DESC LIMIT ? OFFSET ?`, ...params);
    },

    count({ project = null, status = null } = {}) {
        const where = [];
        const params = [];

        if (project) {
            where.push("p.name = ?");
            params.push(project);
        }

        if (status) {
            where.push("d.status = ?");
            params.push(status);
        }

        const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

        return get(`
            SELECT COUNT(*) AS n FROM deployments d JOIN projects p ON p.id = d.repo_id ${clause}
        `, ...params).n;
    },

    get: (id) => get(`${SELECT} WHERE d.id = ?`, id),

    // Two integers that change whenever anything on a deploy page would look
    // different, for the client's change check.
    watermark: () => get(`
        SELECT COALESCE(MAX(id), 0) AS last,
               COUNT(*) FILTER (WHERE status = 'running') AS running
        FROM deployments
    `),

    // The log column is the largest one in the table, so it is only read when
    // the log itself is being displayed.
    log: (id) => get("SELECT log FROM deployments WHERE id = ?", id)?.log ?? null,

    // History is capped per project, so these numbers describe the retained
    // window rather than all time. Good enough for "is this thing healthy".
    stats() {
        const counts = all("SELECT status, COUNT(*) AS n FROM deployments GROUP BY status");

        const total = counts.reduce((sum, row) => sum + row.n, 0);
        const byStatus = Object.fromEntries(counts.map((row) => [row.status, row.n]));
        const average = get("SELECT AVG(duration_ms) AS ms FROM deployments WHERE status = 'success'");
        const last24h = get(`
            SELECT COUNT(*) AS n FROM deployments WHERE started_at > datetime('now', '-1 day')
        `).n;

        return {
            total,
            success: byStatus.success || 0,
            failed: byStatus.failed || 0,
            cancelled: byStatus.cancelled || 0,
            running: byStatus.running || 0,
            last24h,
            averageMs: average.ms === null ? null : Math.round(average.ms),
        };
    },

    // Fourteen buckets drive the activity strip on the overview; one query
    // rather than fourteen.
    activity(days = 14) {
        const rows = all(`
            SELECT date(started_at) AS day,
                   COUNT(*) AS total,
                   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
            FROM deployments
            WHERE started_at > datetime('now', ?)
            GROUP BY day
        `, `-${days} day`);

        const byDay = Object.fromEntries(rows.map((row) => [row.day, row]));
        const out = [];

        for (let back = days - 1; back >= 0; back -= 1) {
            const date = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
            const row = byDay[date];
            out.push({ day: date, total: row?.total || 0, failed: row?.failed || 0 });
        }

        return out;
    },

    // The last few runs of one project, drawn as a sparkline in its card.
    recentStatuses: (projectId, limit = 12) => all(`
        SELECT status, duration_ms FROM deployments
        WHERE repo_id = ? ORDER BY id DESC LIMIT ?
    `, projectId, limit).reverse(),
};

module.exports = deployments;
