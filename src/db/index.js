const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { DB_PATH } = require("../config");
const logger = require("../lib/logger");
const { migrate } = require("./migrations");

const log = logger("db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// This application has been called deploy-server and nimbus on the way to its
// current name, and the database file followed each time. Adopting an older file
// keeps an in-place upgrade from losing the registry and every deploy log; the
// migrations then bring the schema forward.
const LEGACY_NAMES = ["nimbus.db", "deploy-server.db"];

if (!fs.existsSync(DB_PATH)) {
    const directory = path.dirname(DB_PATH);
    const legacy = LEGACY_NAMES
        .map((name) => path.join(directory, name))
        .find((candidate) => candidate !== DB_PATH && fs.existsSync(candidate));

    if (legacy) {
        try {
            // The main file first: on Windows it is the one another running
            // instance holds a lock on, so a second copy of the process fails
            // here having moved nothing.
            for (const suffix of ["", "-wal", "-shm"]) {
                if (fs.existsSync(legacy + suffix)) fs.renameSync(legacy + suffix, DB_PATH + suffix);
            }
            log.info("adopted an existing database", { from: legacy, to: DB_PATH });
        } catch (err) {
            // Carrying on would create an empty database and look like every
            // project had vanished, which is worse than not starting.
            log.error("cannot adopt the existing database", { from: legacy, to: DB_PATH, error: err.message });
            console.error(
                `\n${path.basename(legacy)} could not be renamed to ${path.basename(DB_PATH)}.\n` +
                "Another instance may still be running, or the file may not be writable.\n" +
                "Stop it, or rename the file by hand, and start again.\n",
            );
            process.exit(1);
        }
    }
}

const db = new DatabaseSync(DB_PATH);

db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
`);

const version = migrate(db, log);

log.info("database ready", { path: DB_PATH, version });

// Prepared statements are cached by sqlite itself, so callers can build one per
// call without paying for the parse every time.
const all = (sql, ...params) => db.prepare(sql).all(...params);
const get = (sql, ...params) => db.prepare(sql).get(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

function transaction(work) {
    db.exec("BEGIN");
    try {
        const result = work();
        db.exec("COMMIT");
        return result;
    } catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }
}

module.exports = { db, all, get, run, transaction };
