// Guards every filesystem path built from a webhook payload or a form field.
const PROJECT_NAME = /^[A-Za-z0-9._-]+$/;

// Branches allow slashes (`release/1.2`) but nothing that could escape a ref.
const BRANCH_NAME = /^[A-Za-z0-9._\-/]+$/;

// Container ids and names as docker itself accepts them. Everything reaching
// the docker CLI from a request goes through this first.
const CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// Compose project labels follow the same shape as container names.
const STACK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const GROUP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,47}$/u;

// Hex, hsl or a named token - anything else would end up inside a style
// attribute, so the set stays closed.
const GROUP_COLORS = ["slate", "blue", "violet", "emerald", "amber", "rose", "cyan", "lime"];

class ValidationError extends Error {
    constructor(message, field) {
        super(message);
        this.name = "ValidationError";
        this.status = 400;
        this.field = field;
    }
}

const text = (value, fallback = "") => (typeof value === "string" ? value.trim() : fallback);

function require_(value, field, pattern, hint) {
    const trimmed = text(value);
    if (!trimmed) throw new ValidationError(`${field} is required`, field);
    if (pattern && !pattern.test(trimmed)) throw new ValidationError(hint || `${field} is not valid`, field);
    return trimmed;
}

const optional = (value, field, pattern, hint) => {
    const trimmed = text(value);
    if (!trimmed) return null;
    if (pattern && !pattern.test(trimmed)) throw new ValidationError(hint || `${field} is not valid`, field);
    return trimmed;
};

// A checkbox is absent from a form body when unticked, which is exactly the
// false case.
const checkbox = (value) => Boolean(value);

const integer = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.trunc(parsed), min), max);
};

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

module.exports = {
    PROJECT_NAME,
    BRANCH_NAME,
    CONTAINER_REF,
    STACK_NAME,
    GROUP_NAME,
    GROUP_COLORS,
    ValidationError,
    text,
    required: require_,
    optional,
    checkbox,
    integer,
    oneOf,
};
