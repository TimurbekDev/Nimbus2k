// Each entry runs once, in order, inside a transaction, and the highest applied
// id is stored in `user_version`. Never edit a migration that has shipped - add
// the next one instead.
const migrations = [
    {
        id: 1,
        name: "initial registry and deploy history",
        up: (db) => db.exec(`
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
        `),
    },

    {
        id: 2,
        name: "groups, project metadata, audit log",
        up: (db) => {
            db.exec(`
                CREATE TABLE groups (
                    id          INTEGER PRIMARY KEY,
                    name        TEXT NOT NULL UNIQUE,
                    color       TEXT NOT NULL DEFAULT 'slate',
                    description TEXT,
                    sort_order  INTEGER NOT NULL DEFAULT 0,
                    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
                );

                -- Containers are owned by the docker daemon, not by this
                -- database, so the only thing stored here is the operator's
                -- own annotation of one. Keyed by name because an id changes
                -- every time a container is recreated by a deploy.
                CREATE TABLE container_meta (
                    name       TEXT PRIMARY KEY,
                    group_id   INTEGER REFERENCES groups(id) ON DELETE SET NULL,
                    pinned     INTEGER NOT NULL DEFAULT 0,
                    note       TEXT,
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE audit_log (
                    id         INTEGER PRIMARY KEY,
                    action     TEXT NOT NULL,
                    target     TEXT,
                    detail     TEXT,
                    actor      TEXT NOT NULL DEFAULT 'operator',
                    ip         TEXT,
                    ok         INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE INDEX idx_audit_created ON audit_log(id DESC);

                ALTER TABLE repos ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL;
                ALTER TABLE repos ADD COLUMN description TEXT;
                ALTER TABLE repos ADD COLUMN auto_deploy INTEGER NOT NULL DEFAULT 1;
                ALTER TABLE repos ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

                -- Set by a deploy so the fleet view can tie a running stack
                -- back to the project that produced it.
                ALTER TABLE repos ADD COLUMN stack TEXT;

                ALTER TABLE deployments ADD COLUMN actor TEXT;
            `);
        },
    },

    {
        id: 3,
        name: "rename repos to projects",
        up: (db) => {
            // sqlite carries the foreign key from `deployments` across a table
            // rename, and the index with it, so this is the whole change.
            db.exec(`
                ALTER TABLE repos RENAME TO projects;
                CREATE INDEX IF NOT EXISTS idx_projects_group ON projects(group_id);
            `);
        },
    },

    {
        id: 4,
        name: "webhook delivery log",
        up: (db) => db.exec(`
            -- A push that was ignored leaves no deployment behind, which used
            -- to make "why did nothing happen" unanswerable.
            CREATE TABLE webhook_events (
                id         INTEGER PRIMARY KEY,
                repo       TEXT,
                branch     TEXT,
                event      TEXT NOT NULL,
                outcome    TEXT NOT NULL,
                detail     TEXT,
                commit_sha TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX idx_webhook_created ON webhook_events(id DESC);
        `),
    },

    {
        id: 5,
        name: "remember where a project came from",
        up: (db) => db.exec(`
            -- Set when a project is registered by URL. The checkout is then
            -- Nimbus2k's to create: the first deploy clones it.
            ALTER TABLE projects ADD COLUMN repo_url TEXT;
        `),
    },

    {
        id: 6,
        name: "per-project environment variables",
        up: (db) => db.exec(`
            -- The .env a project's compose file expects. Kept here rather than
            -- in the checkout because the checkout is disposable: a deploy may
            -- clone it from scratch or wipe untracked files, and these values
            -- have to survive both.
            CREATE TABLE project_env (
                id         INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                key        TEXT NOT NULL,
                value      TEXT NOT NULL DEFAULT '',
                position   INTEGER NOT NULL DEFAULT 0,
                UNIQUE (project_id, key)
            );

            CREATE INDEX idx_project_env ON project_env(project_id, position);
        `),
    },
];

function migrate(db, log) {
    const current = db.prepare("PRAGMA user_version").get().user_version;
    const pending = migrations.filter((migration) => migration.id > current);

    if (pending.length === 0) {
        log.debug("schema up to date", { version: current });
        return current;
    }

    for (const migration of pending) {
        db.exec("BEGIN");

        try {
            migration.up(db);
            // PRAGMA does not take a bound parameter, and the value is a
            // hard-coded integer from this file.
            db.exec(`PRAGMA user_version = ${migration.id}`);
            db.exec("COMMIT");
        } catch (err) {
            db.exec("ROLLBACK");
            throw new Error(`migration ${migration.id} (${migration.name}) failed: ${err.message}`);
        }

        log.info("migration applied", { id: migration.id, name: migration.name });
    }

    return pending[pending.length - 1].id;
}

module.exports = { migrate, LATEST: migrations[migrations.length - 1].id };
