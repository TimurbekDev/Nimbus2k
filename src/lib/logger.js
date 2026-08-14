const { NODE_ENV } = require("../config");

// Structured lines in production so a log shipper can parse them; a short
// human-readable form when someone is watching the terminal.
const JSON_LINES = NODE_ENV === "production";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

const PAD = { debug: "DEBUG", info: "INFO ", warn: "WARN ", error: "ERROR" };

function emit(level, scope, message, fields) {
    if (LEVELS[level] < THRESHOLD) return;

    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;

    if (JSON_LINES) {
        stream.write(`${JSON.stringify({
            ts: new Date().toISOString(), level, scope, msg: message, ...fields,
        })}\n`);
        return;
    }

    const extra = fields && Object.keys(fields).length > 0
        ? ` ${Object.entries(fields).map(([key, value]) => `${key}=${format(value)}`).join(" ")}`
        : "";

    stream.write(`${new Date().toISOString()} ${PAD[level]} [${scope}] ${message}${extra}\n`);
}

const format = (value) => {
    if (value instanceof Error) return value.message;
    if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
    return JSON.stringify(value);
};

// Every module takes its own scoped logger so a line always says where it came
// from without each call site repeating the prefix.
const logger = (scope) => ({
    debug: (message, fields) => emit("debug", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    error: (message, fields) => emit("error", scope, message, fields),
});

module.exports = logger;
