// No framework and no build step: the pages are server-rendered EJS, and this
// only keeps them current. Everything reachable here is behind the session
// cookie, so the event stream carries no secrets a tab could not already read.
(function () {
    "use strict";

    var stream = null;

    // ---------------------------------------------------------------- time

    function ago(iso) {
        var seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
        if (seconds < 60) return Math.max(seconds, 0) + "s ago";
        if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
        if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
        return Math.floor(seconds / 86400) + "d ago";
    }

    function tickTimes() {
        document.querySelectorAll("time[data-ago][datetime]").forEach(function (node) {
            node.textContent = ago(node.getAttribute("datetime"));
        });
    }

    // ---------------------------------------------------------------- filter

    function initFilter() {
        var input = document.getElementById("repo-filter");
        if (!input) return;

        var table = document.querySelector("table.filterable");
        var empty = document.querySelector(".empty-filter");
        if (!table) return;

        function apply() {
            var needle = input.value.trim().toLowerCase();
            var shown = 0;

            table.querySelectorAll("tbody tr").forEach(function (row) {
                var hit = !needle || (row.dataset.name || "").toLowerCase().indexOf(needle) !== -1;
                row.hidden = !hit;
                if (hit) shown += 1;
            });

            if (empty) empty.hidden = shown !== 0;
            table.hidden = shown === 0;
        }

        input.addEventListener("input", apply);
        apply();
    }

    // A single-key shortcut is only helpful when it cannot swallow typing.
    document.addEventListener("keydown", function (event) {
        if (event.key !== "/" || event.metaKey || event.ctrlKey) return;

        var tag = (event.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;

        var input = document.getElementById("repo-filter");
        if (!input) return;

        event.preventDefault();
        input.focus();
        input.select();
    });

    // ---------------------------------------------------------------- forms

    function initConfirm() {
        document.querySelectorAll("button[data-confirm]").forEach(function (button) {
            if (button.dataset.bound) return;
            button.dataset.bound = "1";

            button.addEventListener("click", function (event) {
                if (!window.confirm(button.dataset.confirm)) event.preventDefault();
            });
        });
    }

    function initToast() {
        var toast = document.getElementById("toast");
        if (!toast) return;

        setTimeout(function () { toast.classList.add("gone"); }, 4000);

        // The message lives in the query string; drop it so a reload does not
        // announce the same thing again.
        if (window.history.replaceState && location.search.indexOf("msg=") !== -1) {
            window.history.replaceState({}, "", location.pathname);
        }
    }

    // ---------------------------------------------------------------- log

    function logBox() {
        var box = document.getElementById("log");
        return box && box.dataset.live ? box : null;
    }

    function appendLog(line) {
        var box = logBox();
        if (!box) return;

        if (box.textContent === "(empty)") box.textContent = "";

        var follow = document.getElementById("follow");
        var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;

        box.textContent += (box.textContent ? "\n" : "") + line;

        if (!follow || follow.checked || atBottom) box.scrollTop = box.scrollHeight;
    }

    // ---------------------------------------------------------------- refresh

    var pending = null;

    // Re-fetching the page and swapping <main> keeps one source of truth for
    // the markup - the EJS templates - instead of a second renderer here.
    function refresh() {
        if (pending) return;

        pending = setTimeout(function () {
            pending = null;

            var active = document.activeElement;
            var tag = (active && active.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea") return;

            fetch(location.href, { credentials: "same-origin" })
                .then(function (response) { return response.ok ? response.text() : null; })
                .then(function (html) {
                    if (!html) return;

                    var next = new DOMParser().parseFromString(html, "text/html").querySelector("main");
                    var current = document.querySelector("main");
                    if (!next || !current) return;

                    current.replaceWith(next);
                    init();
                })
                .catch(function () { /* a failed refresh is not worth reporting */ });
        }, 400);
    }

    // ---------------------------------------------------------------- stream

    function setDot(state, title) {
        var dot = document.getElementById("live-dot");
        if (!dot) return;

        dot.dataset.state = state;
        dot.title = "live updates: " + title;
    }

    function connect() {
        if (!document.getElementById("live-dot") || stream) return;

        stream = new EventSource("/ui/events");

        stream.onopen = function () { setDot("open", "connected"); };

        stream.onerror = function () {
            // EventSource reconnects on its own; the dot just says so.
            setDot("down", "reconnecting");
        };

        stream.onmessage = function (event) {
            var payload;
            try {
                payload = JSON.parse(event.data);
            } catch (err) {
                return;
            }

            var box = logBox();
            var watching = box ? Number(box.dataset.deployment) : null;

            if (payload.type === "log") {
                if (payload.id === watching) appendLog(payload.line);
                return;
            }

            // A run starting or ending changes badges, counts and history
            // everywhere, and the finished log only exists after the end.
            if (payload.type === "end" && payload.id === watching) {
                location.reload();
                return;
            }

            refresh();
        };
    }

    // ---------------------------------------------------------------- boot

    function init() {
        tickTimes();
        initFilter();
        initConfirm();

        var box = logBox();
        if (box) box.scrollTop = box.scrollHeight;
    }

    init();
    initToast();
    connect();

    setInterval(tickTimes, 15000);
})();
