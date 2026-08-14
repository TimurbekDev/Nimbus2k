// sqlite writes `datetime('now')`, which is UTC without a marker; parsed as-is
// a browser in UTC+5 would read every timestamp five hours early.
const parseTime = (value) => {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === "number") return new Date(value);
    return new Date(`${value.replace(" ", "T")}Z`);
};

const fmt = {
    // Rendered server-side so the page reads correctly without JavaScript; the
    // client then keeps these ticking.
    ago(value) {
        const date = parseTime(value);
        if (!date || Number.isNaN(date.getTime())) return "—";

        const seconds = Math.round((Date.now() - date.getTime()) / 1000);
        if (seconds < 45) return "just now";
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
        return `${Math.floor(seconds / 2592000)}mo ago`;
    },

    iso(value) {
        const date = parseTime(value);
        return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
    },

    stamp(value) {
        const date = parseTime(value);
        if (!date || Number.isNaN(date.getTime())) return "—";
        return `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;
    },

    duration(ms) {
        if (ms === null || ms === undefined) return "—";
        if (ms < 1000) return `${Math.round(ms)}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;

        const minutes = Math.floor(ms / 60000);
        const seconds = Math.round((ms % 60000) / 1000);
        if (minutes < 60) return `${minutes}m ${seconds}s`;

        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    },

    sha: (value) => (value ? value.slice(0, 7) : "—"),

    percent(part, total, { dash = "—" } = {}) {
        if (!total) return dash;
        return `${Math.round((part / total) * 100)}%`;
    },

    ratio: (part, total) => (total ? part / total : 0),

    bytes(value) {
        const size = Number(value);
        if (!Number.isFinite(size) || size <= 0) return "0 B";

        const units = ["B", "KB", "MB", "GB", "TB"];
        const power = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
        const scaled = size / 1024 ** power;

        return `${scaled >= 100 || power === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[power]}`;
    },

    // "12.34%" from `docker stats` is a string; the meters need a number.
    number: (value, fallback = 0) => {
        const parsed = parseFloat(String(value ?? "").replace(/[^\d.-]/g, ""));
        return Number.isFinite(parsed) ? parsed : fallback;
    },

    // Turns a long name into something that still fits a table cell.
    truncate: (value, length = 48) => {
        const text = String(value ?? "");
        return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
    },

    // Image references are the widest column in the fleet table and the least
    // interesting part is usually the registry host.
    image(value) {
        const text = String(value ?? "");
        if (!text) return "—";

        const [ref, digest] = text.split("@");
        const parts = ref.split("/");
        const short = parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : ref;

        return digest ? `${short}@${digest.slice(0, 14)}…` : short;
    },

    initials(value) {
        const words = String(value ?? "?").split(/[\s._-]+/).filter(Boolean);
        if (words.length === 0) return "?";
        if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
        return (words[0][0] + words[1][0]).toUpperCase();
    },

    plural: (count, one, many) => `${count} ${count === 1 ? one : many || `${one}s`}`,
};

module.exports = fmt;
