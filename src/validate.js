// Guards every filesystem path built from a webhook payload or a form field.
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

// Branches allow slashes (`release/1.2`) but nothing that could escape a ref.
const BRANCH_NAME = /^[A-Za-z0-9._\-/]+$/;

module.exports = { REPO_NAME, BRANCH_NAME };
