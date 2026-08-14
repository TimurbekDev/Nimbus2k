const { EventEmitter } = require("node:events");

// One process-wide channel for anything a browser should see the moment it
// happens: deploy lifecycle, deploy log lines, container state changes. The SSE
// endpoint is the only subscriber that matters, and it fans out to every open
// tab.
//
// No listener cap: one subscriber per connected tab is normal, and none of them
// leak - they unsubscribe when the request closes.
const bus = new EventEmitter();
bus.setMaxListeners(0);

const CHANNEL = "event";

// A payload always carries `type`; the client switches on it. Kept flat and
// JSON-serialisable because it goes straight into an SSE frame.
const publish = (type, payload = {}) => bus.emit(CHANNEL, { type, at: Date.now(), ...payload });

const subscribe = (handler) => {
    bus.on(CHANNEL, handler);
    return () => bus.off(CHANNEL, handler);
};

module.exports = { publish, subscribe };
