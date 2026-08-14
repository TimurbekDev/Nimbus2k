// sqlite writes `datetime('now')`, which is UTC without a marker; parsed as-is
// a browser in UTC+5 would read every timestamp five hours early.
const parseTime = (value) => (value ? new Date(`${value.replace(" ", "T")}Z`) : null);

const fmt = {
    // Rendered server-side so the page reads correctly without JavaScript; the
    // client then keeps these ticking.
    ago(value) {
        const date = parseTime(value);
        if (!date) return "-";

        const seconds = Math.round((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    },

    iso(value) {
        const date = parseTime(value);
        return date ? date.toISOString() : "";
    },

    stamp(value) {
        const date = parseTime(value);
        return date ? `${date.toISOString().replace("T", " ").slice(0, 19)} UTC` : "-";
    },

    duration(ms) {
        if (ms === null || ms === undefined) return "-";
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
    },

    sha: (value) => (value ? value.slice(0, 7) : "-"),

    percent(part, total) {
        if (!total) return "-";
        return `${Math.round((part / total) * 100)}%`;
    },
};

module.exports = fmt;
