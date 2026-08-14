const express = require("express");

const { subscribe } = require("../../../lib/bus");
const docker = require("../../../services/docker.service");
const { CONTAINER_REF } = require("../../../lib/validate");

const router = express.Router();

// Server-sent events rather than polling: a deploy produces output in bursts,
// and every open tab should see a line the moment it is written.
function openStream(req, res) {
    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // nginx buffers a proxied response by default, which would hold every
        // line back until the deploy finished.
        "X-Accel-Buffering": "no",
    });

    res.flushHeaders();
    res.write("retry: 3000\n\n");
    res.write(": connected\n\n");

    // Also keeps the proxy from closing an idle connection at proxy_read_timeout.
    const beat = setInterval(() => res.write(": ping\n\n"), 25000);

    return {
        send: (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`),
        onClose: (cleanup) => req.on("close", () => {
            clearInterval(beat);
            cleanup();
        }),
    };
}

router.get("/events", (req, res) => {
    const { send, onClose } = openStream(req, res);
    onClose(subscribe(send));
});

// A container's own output, followed live. Separate from the app-wide stream
// because a page showing one container should not carry every other tab's
// deploy log.
router.get("/containers/:ref/stream", (req, res, next) => {
    const { ref } = req.params;
    if (!CONTAINER_REF.test(ref)) return next();

    const { send, onClose } = openStream(req, res);

    const follower = docker.followLogs(ref, {
        tail: 200,
        onLine: (line) => send({ type: "container-log", ref, line }),
    });

    onClose(() => follower.close());
});

module.exports = router;
