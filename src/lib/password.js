const crypto = require("node:crypto");

// Kept free of any dependency on the configuration so the hashing tool can use
// it without a fully configured environment.

// scrypt$<N>$<r>$<p>$<salt base64>$<key base64>. Self-describing so the cost
// parameters can be raised later without invalidating existing hashes.
const DEFAULTS = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAXMEM = 256 * 1024 * 1024;

function hash(password, options = {}) {
    const { N, r, p, keylen } = { ...DEFAULTS, ...options };
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, keylen, { N, r, p, maxmem: MAXMEM });

    return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

function verify(password, stored) {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;

    const [, N, r, p, salt, key] = parts;
    const expected = Buffer.from(key, "base64");

    let actual;
    try {
        actual = crypto.scryptSync(String(password ?? ""), Buffer.from(salt, "base64"), expected.length, {
            N: Number(N), r: Number(r), p: Number(p), maxmem: MAXMEM,
        });
    } catch {
        // A malformed hash is a configuration error, not a reason to let anyone in.
        return false;
    }

    return expected.length > 0 && crypto.timingSafeEqual(expected, actual);
}

// Both sides are digested first, so inputs of different lengths can still be
// compared in constant time and the comparison never reveals how much of a
// guess was right.
function sameSecret(a, b) {
    const digest = (value) => crypto.createHash("sha256").update(String(value ?? "")).digest();
    return crypto.timingSafeEqual(digest(a), digest(b));
}

const looksHashed = (value) => typeof value === "string" && value.startsWith("scrypt$");

module.exports = { hash, verify, sameSecret, looksHashed };
