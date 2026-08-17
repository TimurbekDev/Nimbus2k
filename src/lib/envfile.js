const { ValidationError } = require("./validate");

/*
 * The .env file a project's compose stack reads.
 *
 * Deliberately a small, strict subset of what dotenv accepts: single-line
 * values, no interpolation, no `export`. A file Nimbus2k writes has to mean the
 * same thing to docker compose, to dotenv and to whoever opens it in an editor,
 * and the ways those three disagree all live in the parts left out here.
 */

// The shape every loader agrees on.
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MAX_KEYS = 200;
const MAX_VALUE = 4096;

// A value that would change meaning unquoted: any whitespace at all - not only
// at the ends, since `#` after a space starts a comment in most readers - a
// quote, or a character a shell-flavoured parser might take an interest in. An
// empty value is quoted too, so the line cannot be mistaken for an unset key.
const NEEDS_QUOTES = /[\s"'#$`\\]|^$/;

/**
 * Parses pasted .env text into ordered `{ key, value }` pairs. Unparseable
 * lines are reported rather than silently dropped: a typo in a database URL is
 * not something to discover at deploy time.
 */
function parse(text) {
    const pairs = [];
    const problems = [];
    const seen = new Set();

    const lines = String(text ?? "").split(/\r?\n/);

    lines.forEach((raw, index) => {
        const line = raw.trim();
        if (!line || line.startsWith("#")) return;

        // `export FOO=bar` is common in pasted snippets and means the same thing.
        const body = line.startsWith("export ") ? line.slice(7).trim() : line;

        const eq = body.indexOf("=");
        if (eq === -1) {
            problems.push(`line ${index + 1}: no "=" in ${JSON.stringify(line.slice(0, 40))}`);
            return;
        }

        const key = body.slice(0, eq).trim();
        if (!KEY.test(key)) {
            problems.push(`line ${index + 1}: ${JSON.stringify(key.slice(0, 40))} is not a usable name`);
            return;
        }

        if (seen.has(key)) {
            problems.push(`line ${index + 1}: ${key} appears more than once`);
            return;
        }

        seen.add(key);
        pairs.push({ key, value: unquote(body.slice(eq + 1).trim()) });
    });

    return { pairs, problems };
}

function unquote(value) {
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) {
        const inner = value.slice(1, -1);
        return value.startsWith('"') ? inner.replace(/\\(["\\n])/g, (_, ch) => (ch === "n" ? "\n" : ch)) : inner;
    }

    return value;
}

/** Validates one pair, or throws. Returns the cleaned pair. */
function check({ key, value }) {
    const name = String(key ?? "").trim();

    if (!KEY.test(name)) {
        throw new ValidationError(
            `"${name.slice(0, 40)}" is not a usable variable name — letters, digits and underscore, not starting with a digit`,
            "env",
        );
    }

    const text = String(value ?? "");

    if (text.includes("\n")) {
        throw new ValidationError(`${name} spans more than one line, which a .env file cannot hold`, "env");
    }

    if (text.length > MAX_VALUE) {
        throw new ValidationError(`${name} is longer than ${MAX_VALUE} characters`, "env");
    }

    return { key: name, value: text };
}

function checkAll(pairs) {
    if (pairs.length > MAX_KEYS) {
        throw new ValidationError(`That is more than ${MAX_KEYS} variables`, "env");
    }

    const seen = new Set();

    return pairs.map((pair) => {
        const clean = check(pair);

        if (seen.has(clean.key)) {
            throw new ValidationError(`${clean.key} is set twice`, "env");
        }

        seen.add(clean.key);
        return clean;
    });
}

/** Renders pairs as the file that gets written next to the compose file. */
function format(pairs, { header = null } = {}) {
    const lines = [];

    if (header) for (const line of header.split("\n")) lines.push(`# ${line}`);
    if (header) lines.push("");

    for (const { key, value } of pairs) {
        lines.push(`${key}=${NEEDS_QUOTES.test(value) ? quote(value) : value}`);
    }

    return `${lines.join("\n")}\n`;
}

const quote = (value) => `"${value.replace(/([\\"$`])/g, "\\$1")}"`;

// Deliberately broad: a false positive costs one click on "reveal", a false
// negative shows a password to whoever is looking at the screen.
const SECRET_KEY = /(PASS|SECRET|TOKEN|KEY|CRED|AUTH|PRIVATE|SALT|DSN|SIGNATURE)/i;

const isSecret = (key) => SECRET_KEY.test(String(key ?? ""));

module.exports = { parse, format, check, checkAll, isSecret, KEY, MAX_KEYS, MAX_VALUE };
