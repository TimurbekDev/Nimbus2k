const { all, get, run } = require("./index");
const { AUDIT_HISTORY } = require("../config");
const logger = require("../lib/logger");

const log = logger("audit");

// Every state-changing action lands here: who asked, what for, and whether it
// worked. There is one operator token rather than named accounts, so `actor`
// records the channel (ui / api / webhook) and `ip` the caller.
const audit = {
    record({ action, target = null, detail = null, actor = "ui", ip = null, ok = true }) {
        run(`
            INSERT INTO audit_log (action, target, detail, actor, ip, ok)
            VALUES (?, ?, ?, ?, ?, ?)
        `, action, target, detail, actor, ip, ok ? 1 : 0);

        log.info(action, { target, actor, ok });

        // Trimmed inline: an audit table is append-only and nothing else would
        // ever bound it.
        if (Math.random() < 0.05) audit.trim();
    },

    trim() {
        run(`
            DELETE FROM audit_log
            WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?)
        `, AUDIT_HISTORY);
    },

    list: ({ limit = 50, offset = 0 } = {}) => all(`
        SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?
    `, limit, offset).map((row) => ({ ...row, ok: Boolean(row.ok) })),

    count: () => get("SELECT COUNT(*) AS n FROM audit_log").n,
};

// ------------------------------------------------------------------ webhooks

// A push that was ignored leaves no deployment behind, which used to make "why
// did nothing happen after I pushed" unanswerable from the UI.
const webhookEvents = {
    record({ repo = null, branch = null, event, outcome, detail = null, commitSha = null }) {
        run(`
            INSERT INTO webhook_events (repo, branch, event, outcome, detail, commit_sha)
            VALUES (?, ?, ?, ?, ?, ?)
        `, repo, branch, event, outcome, detail, commitSha);

        if (Math.random() < 0.05) {
            run(`
                DELETE FROM webhook_events
                WHERE id NOT IN (SELECT id FROM webhook_events ORDER BY id DESC LIMIT 500)
            `);
        }
    },

    list: ({ limit = 25 } = {}) => all("SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?", limit),

    lastFor: (repo) => get("SELECT * FROM webhook_events WHERE repo = ? ORDER BY id DESC LIMIT 1", repo),
};

module.exports = { audit, webhookEvents };
