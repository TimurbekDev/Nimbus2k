const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { DB_PATH, DEPLOYMENT_HISTORY } = require("./config");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS repos (
        id              INTEGER PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        branch          TEXT NOT NULL DEFAULT 'master',
        path            TEXT NOT NULL,
        compose_file    TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        prune_images    INTEGER NOT NULL DEFAULT 1,
        clean_untracked INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deployments (
        id          INTEGER PRIMARY KEY,
        repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        branch      TEXT NOT NULL,
        commit_sha  TEXT,
        trigger     TEXT NOT NULL DEFAULT 'webhook',
        status      TEXT NOT NULL,
        error       TEXT,
        log         TEXT,
        started_at  TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_deployments_repo ON deployments(repo_id, id DESC);
`);

// A row read back from sqlite carries integers where the API should expose
// booleans.
const toRepo = (row) => row && {
    ...row,
    enabled: Boolean(row.enabled),
    prune_images: Boolean(row.prune_images),
    clean_untracked: Boolean(row.clean_untracked),
};

const REPO_FIELDS = ["branch", "path", "compose_file", "enabled", "prune_images", "clean_untracked"];

const repos = {
    byName(name) {
        return toRepo(db.prepare("SELECT * FROM repos WHERE name = ?").get(name));
    },

    list() {
        return db.prepare("SELECT * FROM repos ORDER BY name").all().map(toRepo);
    },

    create({ name, branch, path: repoPath, compose_file = null, prune_images = true, clean_untracked = false }) {
        db.prepare(`
            INSERT INTO repos (name, branch, path, compose_file, prune_images, clean_untracked)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(name, branch, repoPath, compose_file, prune_images ? 1 : 0, clean_untracked ? 1 : 0);

        return repos.byName(name);
    },

    update(name, patch) {
        const columns = [];
        const values = [];

        for (const field of REPO_FIELDS) {
            if (patch[field] === undefined) continue;
            columns.push(`${field} = ?`);
            values.push(typeof patch[field] === "boolean" ? Number(patch[field]) : patch[field]);
        }

        if (columns.length === 0) return repos.byName(name);

        values.push(name);
        db.prepare(`UPDATE repos SET ${columns.join(", ")}, updated_at = datetime('now') WHERE name = ?`).run(...values);

        return repos.byName(name);
    },

    remove(name) {
        return db.prepare("DELETE FROM repos WHERE name = ?").run(name).changes > 0;
    },
};

const deployments = {
    start(repoId, branch, commitSha, trigger) {
        const { lastInsertRowid } = db.prepare(`
            INSERT INTO deployments (repo_id, branch, commit_sha, trigger, status)
            VALUES (?, ?, ?, ?, 'running')
        `).run(repoId, branch, commitSha, trigger);

        return Number(lastInsertRowid);
    },

    finish(id, { status, error = null, log = null, durationMs }) {
        db.prepare(`
            UPDATE deployments
            SET status = ?, error = ?, log = ?, finished_at = datetime('now'), duration_ms = ?
            WHERE id = ?
        `).run(status, error, log, durationMs, id);
    },

    // Called after a deploy finishes so old logs do not grow the file forever.
    prune(repoId) {
        db.prepare(`
            DELETE FROM deployments
            WHERE repo_id = ?
              AND id NOT IN (SELECT id FROM deployments WHERE repo_id = ? ORDER BY id DESC LIMIT ?)
        `).run(repoId, repoId, DEPLOYMENT_HISTORY);
    },

    list({ repo = null, limit = 20 } = {}) {
        const sql = `
            SELECT d.id, r.name AS repo, d.branch, d.commit_sha, d.trigger,
                   d.status, d.error, d.started_at, d.finished_at, d.duration_ms
            FROM deployments d
            JOIN repos r ON r.id = d.repo_id
            ${repo ? "WHERE r.name = ?" : ""}
            ORDER BY d.id DESC
            LIMIT ?
        `;

        return repo ? db.prepare(sql).all(repo, limit) : db.prepare(sql).all(limit);
    },

    get(id) {
        return db.prepare(`
            SELECT d.*, r.name AS repo
            FROM deployments d
            JOIN repos r ON r.id = d.repo_id
            WHERE d.id = ?
        `).get(id);
    },
};

module.exports = { db, repos, deployments };
