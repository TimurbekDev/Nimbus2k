/*
 * Nimbus2k client.
 *
 * No framework and no build step: the pages are server-rendered EJS, and this
 * keeps them current, adds the keyboard surface, and handles the pieces that
 * only make sense in a browser. Everything reachable here is behind the session
 * cookie, so the event stream carries nothing a tab could not already read.
 */
(function () {
    "use strict";

    var $ = function (selector, root) { return (root || document).querySelector(selector); };
    var $$ = function (selector, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(selector));
    };

    var store = {
        get: function (key, fallback) {
            try { var value = localStorage.getItem(key); return value === null ? fallback : value; }
            catch (err) { return fallback; }
        },
        set: function (key, value) {
            try { localStorage.setItem(key, value); } catch (err) { /* storage disabled */ }
        },
    };

    // ---------------------------------------------------------------- toasts

    var ICONS = { ok: "check-circle", warn: "alert-triangle", bad: "alert-circle", info: "info" };

    function toast(text, tone, ttl) {
        var host = $(".toasts");
        if (!host) return;

        var node = document.createElement("div");
        node.className = "toast " + (tone || "info");
        node.setAttribute("role", "status");
        node.innerHTML =
            '<svg class="i" aria-hidden="true"><use href="#i-' + (ICONS[tone] || "info") + '"></use></svg>' +
            "<span></span>";
        node.lastChild.textContent = text;

        host.appendChild(node);

        setTimeout(function () {
            node.classList.add("gone");
            setTimeout(function () { node.remove(); }, 400);
        }, ttl || 4200);
    }

    // A flash rendered by the server should not announce itself again on reload.
    function initFlash() {
        $$(".toast[data-flash]").forEach(function (node) {
            setTimeout(function () {
                node.classList.add("gone");
                setTimeout(function () { node.remove(); }, 400);
            }, 4200);
        });

        if (window.history.replaceState && location.search.indexOf("msg=") !== -1) {
            var params = new URLSearchParams(location.search);
            params.delete("msg");
            var query = params.toString();
            window.history.replaceState({}, "", location.pathname + (query ? "?" + query : ""));
        }
    }

    // ---------------------------------------------------------------- time

    function ago(iso) {
        var seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
        if (seconds < 45) return "just now";
        if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
        if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
        if (seconds < 2592000) return Math.floor(seconds / 86400) + "d ago";
        return Math.floor(seconds / 2592000) + "mo ago";
    }

    function elapsed(ms) {
        var seconds = Math.floor(ms / 1000);
        if (seconds < 60) return seconds + "s";
        return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
    }

    function tickTimes() {
        $$("time[data-ago][datetime]").forEach(function (node) {
            node.textContent = ago(node.getAttribute("datetime"));
        });

        $$("[data-elapsed]").forEach(function (node) {
            var since = Number(node.getAttribute("data-elapsed"));
            if (since) node.textContent = elapsed(Date.now() - since);
        });
    }

    // ---------------------------------------------------------------- chrome

    function initChrome() {
        var shell = $(".shell");

        var collapsed = store.get("nimbus2k.sidebar", "") === "collapsed";
        if (shell) shell.setAttribute("data-collapsed", collapsed ? "1" : "0");

        var toggle = $("#sidebar-collapse");
        if (toggle && !toggle.dataset.bound) {
            toggle.dataset.bound = "1";
            toggle.addEventListener("click", function () {
                var next = shell.getAttribute("data-collapsed") !== "1";
                shell.setAttribute("data-collapsed", next ? "1" : "0");
                store.set("nimbus2k.sidebar", next ? "collapsed" : "expanded");
            });
        }

        var mobile = $("#sidebar-open");
        if (mobile && !mobile.dataset.bound) {
            mobile.dataset.bound = "1";
            mobile.addEventListener("click", function () {
                shell.setAttribute("data-mobile", shell.getAttribute("data-mobile") === "open" ? "" : "open");
            });
        }

        // Three states, cycled in the order an operator expects: whatever they
        // are on now, the other one, then back to following the system.
        var themeButton = $("#theme-toggle");
        if (themeButton && !themeButton.dataset.bound) {
            themeButton.dataset.bound = "1";
            themeButton.addEventListener("click", function () {
                var current = document.documentElement.getAttribute("data-theme") || "system";
                var next = current === "dark" ? "light" : current === "light" ? "system" : "dark";

                if (next === "system") document.documentElement.removeAttribute("data-theme");
                else document.documentElement.setAttribute("data-theme", next);

                store.set("nimbus2k.theme", next);
                themeButton.setAttribute("title", "Theme: " + next);
                toast("Theme: " + next, "info", 1600);
            });
        }
    }

    // ---------------------------------------------------------------- buckets

    // Which stacks an operator collapsed should survive the auto-refresh, and
    // the next visit.
    function initBuckets() {
        $$(".bucket").forEach(function (bucket) {
            var key = "nimbus2k.bucket." + bucket.dataset.key;
            if (store.get(key, "1") === "0") bucket.setAttribute("data-open", "0");

            var head = $(".bucket-head", bucket);
            if (!head || head.dataset.bound) return;
            head.dataset.bound = "1";

            head.addEventListener("click", function (event) {
                // The header carries its own buttons and forms; only a click on
                // the header itself toggles.
                if (event.target.closest("button, a, form, label, input, select")) return;

                var open = bucket.getAttribute("data-open") !== "0";
                bucket.setAttribute("data-open", open ? "0" : "1");
                store.set(key, open ? "0" : "1");
            });
        });

        var expand = $("#buckets-expand");
        if (expand && !expand.dataset.bound) {
            expand.dataset.bound = "1";
            expand.addEventListener("click", function () {
                var anyOpen = $$(".bucket").some(function (b) { return b.getAttribute("data-open") !== "0"; });
                $$(".bucket").forEach(function (bucket) {
                    bucket.setAttribute("data-open", anyOpen ? "0" : "1");
                    store.set("nimbus2k.bucket." + bucket.dataset.key, anyOpen ? "0" : "1");
                });
            });
        }
    }

    // ---------------------------------------------------------------- filters

    // A filter form submits itself, so the URL always describes the view and
    // stays shareable. Text inputs wait for a pause in typing.
    function initFilters() {
        $$("form[data-autosubmit]").forEach(function (form) {
            if (form.dataset.bound) return;
            form.dataset.bound = "1";

            var timer = null;

            form.addEventListener("input", function (event) {
                var field = event.target;
                if (field.type === "search" || field.type === "text") {
                    clearTimeout(timer);
                    timer = setTimeout(function () { form.requestSubmit(); }, 380);
                    return;
                }

                form.requestSubmit();
            });
        });
    }

    // ---------------------------------------------------------------- confirm

    function initConfirm() {
        $$("[data-confirm]").forEach(function (node) {
            if (node.dataset.bound) return;
            node.dataset.bound = "1";

            node.addEventListener("click", function (event) {
                if (!window.confirm(node.getAttribute("data-confirm"))) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            });
        });
    }

    function initCopy() {
        $$("[data-copy]").forEach(function (node) {
            if (node.dataset.bound) return;
            node.dataset.bound = "1";

            node.addEventListener("click", function () {
                var text = node.getAttribute("data-copy");
                if (!navigator.clipboard) return toast("Clipboard is unavailable", "warn");

                navigator.clipboard.writeText(text)
                    .then(function () { toast("Copied", "ok", 1400); })
                    .catch(function () { toast("Could not copy", "bad"); });
            });
        });
    }

    // Reveals one masked environment value at a time.
    function initSecrets() {
        $$("[data-secret]").forEach(function (node) {
            if (node.dataset.bound) return;
            node.dataset.bound = "1";

            node.addEventListener("click", function () {
                var target = node.previousElementSibling;
                var shown = node.getAttribute("data-shown") === "1";

                target.textContent = shown ? "••••••••" : node.getAttribute("data-secret");
                node.setAttribute("data-shown", shown ? "0" : "1");
                node.textContent = shown ? "reveal" : "hide";
            });
        });
    }

    // ---------------------------------------------------------------- log

    function logBox() { return $("#log"); }

    function appendLog(line) {
        var box = logBox();
        if (!box || !box.dataset.live) return;

        if (box.textContent === "(no output yet)") box.textContent = "";

        var follow = $("#follow");
        var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;

        box.textContent += (box.textContent ? "\n" : "") + line;

        if (!follow || follow.checked || atBottom) box.scrollTop = box.scrollHeight;
    }

    function initLog() {
        var box = logBox();
        if (!box) return;

        box.scrollTop = box.scrollHeight;

        var wrap = $("#log-wrap");
        if (wrap && !wrap.dataset.bound) {
            wrap.dataset.bound = "1";
            wrap.addEventListener("change", function () {
                box.style.whiteSpace = wrap.checked ? "pre-wrap" : "pre";
            });
        }
    }

    // A container's own output, streamed while the page is open.
    function initContainerStream() {
        var box = $("#container-log");
        if (!box || box.dataset.bound) return;
        box.dataset.bound = "1";

        var source = new EventSource("/ui/containers/" + encodeURIComponent(box.dataset.ref) + "/stream");

        source.onmessage = function (event) {
            var payload;
            try { payload = JSON.parse(event.data); } catch (err) { return; }
            if (payload.type !== "container-log") return;

            var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
            if (box.textContent === "(no output yet)") box.textContent = "";
            box.textContent += (box.textContent ? "\n" : "") + payload.line;

            var follow = $("#follow-container");
            if (!follow || follow.checked || atBottom) box.scrollTop = box.scrollHeight;
        };

        window.addEventListener("beforeunload", function () { source.close(); });
    }

    // ---------------------------------------------------------------- palette

    var palette = { items: null, filtered: [], index: 0 };

    var STATIC_ITEMS = [
        { group: "Go to", label: "Overview", href: "/ui", icon: "grid" },
        { group: "Go to", label: "Projects", href: "/ui/projects", icon: "git" },
        { group: "Go to", label: "Fleet", href: "/ui/containers", icon: "box" },
        { group: "Go to", label: "Groups", href: "/ui/groups", icon: "folder" },
        { group: "Go to", label: "Deployments", href: "/ui/deployments", icon: "history" },
        { group: "Go to", label: "Settings", href: "/ui/settings", icon: "settings" },
        { group: "Fleet", label: "Group containers by stack", href: "/ui/containers?by=stack", icon: "layers" },
        { group: "Fleet", label: "Group containers by group", href: "/ui/containers?by=group", icon: "folder" },
        { group: "Fleet", label: "Group containers by project", href: "/ui/containers?by=project", icon: "git" },
        { group: "Fleet", label: "Only unhealthy containers", href: "/ui/containers?state=unhealthy", icon: "alert-triangle" },
        { group: "Fleet", label: "Only stopped containers", href: "/ui/containers?state=stopped", icon: "square" },
        { group: "Deployments", label: "Failed deployments", href: "/ui/deployments?status=failed", icon: "alert-circle" },
        { group: "Deployments", label: "Running deployments", href: "/ui/deployments?status=running", icon: "activity" },
    ];

    function openPalette() {
        var backdrop = $("#palette");
        if (!backdrop) return;

        backdrop.hidden = false;
        var input = $("#palette-input");
        input.value = "";
        input.focus();

        if (palette.items) return renderPalette("");

        renderPalette("");

        // Projects and containers change while the page is open, so the index
        // is fetched rather than baked into the document.
        fetch("/ui/palette.json", { credentials: "same-origin", headers: { Accept: "application/json" } })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (data) {
                if (!data) return;
                palette.items = STATIC_ITEMS.concat(data.items || []);
                renderPalette($("#palette-input").value);
            })
            .catch(function () { /* the static entries are still useful */ });
    }

    function closePalette() {
        var backdrop = $("#palette");
        if (backdrop) backdrop.hidden = true;
    }

    function renderPalette(query) {
        var results = $("#palette-results");
        if (!results) return;

        var needle = query.trim().toLowerCase();
        var source = palette.items || STATIC_ITEMS;

        palette.filtered = source.filter(function (item) {
            if (!needle) return true;
            return (item.label + " " + (item.meta || "") + " " + item.group).toLowerCase().indexOf(needle) !== -1;
        }).slice(0, 40);

        palette.index = 0;
        results.innerHTML = "";

        if (palette.filtered.length === 0) {
            var empty = document.createElement("div");
            empty.className = "palette-group";
            empty.textContent = "Nothing matches";
            results.appendChild(empty);
            return;
        }

        var lastGroup = null;

        palette.filtered.forEach(function (item, index) {
            if (item.group !== lastGroup) {
                lastGroup = item.group;
                var heading = document.createElement("div");
                heading.className = "palette-group";
                heading.textContent = item.group;
                results.appendChild(heading);
            }

            var button = document.createElement("button");
            button.type = "button";
            button.className = "palette-item";
            button.setAttribute("aria-selected", index === 0 ? "true" : "false");
            button.dataset.index = String(index);
            button.innerHTML =
                '<svg class="i" aria-hidden="true"><use href="#i-' + (item.icon || "arrow-right") + '"></use></svg>' +
                "<span></span>" +
                (item.meta ? '<span class="meta"></span>' : "");

            button.children[1].textContent = item.label;
            if (item.meta) button.lastChild.textContent = item.meta;

            button.addEventListener("click", function () { location.href = item.href; });
            results.appendChild(button);
        });
    }

    function movePalette(delta) {
        var buttons = $$(".palette-item");
        if (buttons.length === 0) return;

        palette.index = (palette.index + delta + buttons.length) % buttons.length;

        buttons.forEach(function (button, index) {
            button.setAttribute("aria-selected", index === palette.index ? "true" : "false");
        });

        buttons[palette.index].scrollIntoView({ block: "nearest" });
    }

    function initPalette() {
        var trigger = $("#palette-trigger");
        if (trigger && !trigger.dataset.bound) {
            trigger.dataset.bound = "1";
            trigger.addEventListener("click", openPalette);
        }

        var backdrop = $("#palette");
        if (backdrop && !backdrop.dataset.bound) {
            backdrop.dataset.bound = "1";

            backdrop.addEventListener("click", function (event) {
                if (event.target === backdrop) closePalette();
            });

            $("#palette-input").addEventListener("input", function (event) {
                renderPalette(event.target.value);
            });

            $("#palette-input").addEventListener("keydown", function (event) {
                if (event.key === "ArrowDown") { event.preventDefault(); movePalette(1); }
                else if (event.key === "ArrowUp") { event.preventDefault(); movePalette(-1); }
                else if (event.key === "Enter") {
                    event.preventDefault();
                    var item = palette.filtered[palette.index];
                    if (item) location.href = item.href;
                }
            });
        }
    }

    // ---------------------------------------------------------------- keys

    var TYPING = { INPUT: 1, TEXTAREA: 1, SELECT: 1 };

    document.addEventListener("keydown", function (event) {
        var typing = TYPING[(event.target.tagName || "").toUpperCase()] || event.target.isContentEditable;

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            return openPalette();
        }

        if (event.key === "Escape") {
            closePalette();
            return;
        }

        if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

        // A single-key shortcut is only helpful when it cannot swallow typing.
        if (event.key === "/") {
            var search = $("[data-search]");
            if (search) {
                event.preventDefault();
                search.focus();
                search.select();
            }
            return;
        }

        if (event.key === "?") {
            event.preventDefault();
            return openPalette();
        }

        if (event.key === "r" && event.shiftKey === false) {
            var refreshable = $("[data-refresh]");
            if (refreshable) { event.preventDefault(); refresh(true); }
        }
    });

    // ---------------------------------------------------------------- refresh

    var pending = null;
    var refreshing = false;

    // Re-fetching the page and swapping the main region keeps one source of
    // truth for the markup - the EJS templates - instead of a second renderer
    // here.
    function refresh(immediate) {
        if (pending) clearTimeout(pending);

        pending = setTimeout(function () {
            pending = null;
            if (refreshing || document.hidden) return;

            // Never yank the ground out from under someone mid-edit.
            var active = document.activeElement;
            if (active && (TYPING[(active.tagName || "").toUpperCase()] || active.isContentEditable)) return;
            if (!$("#palette") || !$("#palette").hidden) return;

            refreshing = true;

            fetch(location.href, { credentials: "same-origin" })
                .then(function (response) { return response.ok ? response.text() : null; })
                .then(function (html) {
                    if (!html) return;

                    var next = new DOMParser().parseFromString(html, "text/html").querySelector(".page");
                    var current = $(".page");
                    if (!next || !current) return;

                    var scroll = window.scrollY;
                    current.replaceWith(next);
                    window.scrollTo(0, scroll);
                    init();
                })
                .catch(function () { /* a failed refresh is not worth reporting */ })
                .finally(function () { refreshing = false; });
        }, immediate ? 0 : 450);
    }

    // ---------------------------------------------------------------- stream

    var streamSource = null;

    function setDot(state, title) {
        var dot = $("#live-dot");
        if (!dot) return;

        dot.dataset.state = state;
        dot.setAttribute("title", "Live updates: " + title);
    }

    function connect() {
        if (!$("#live-dot") || streamSource) return;

        streamSource = new EventSource("/ui/events");

        streamSource.onopen = function () { setDot("open", "connected"); };

        // EventSource reconnects on its own; the dot just says so.
        streamSource.onerror = function () { setDot("down", "reconnecting"); };

        streamSource.onmessage = function (event) {
            var payload;
            try { payload = JSON.parse(event.data); } catch (err) { return; }

            var box = logBox();
            var watching = box ? Number(box.dataset.deployment) : null;

            if (payload.type === "log") {
                if (payload.id === watching) appendLog(payload.line);
                return;
            }

            if (payload.type === "deploy:end") {
                // The finished log only exists in the database after the end,
                // and the page has a different shape once a run is over.
                if (payload.id === watching) return location.reload();

                toast(
                    payload.project + ": deploy " + payload.status,
                    payload.status === "success" ? "ok" : payload.status === "failed" ? "bad" : "warn"
                );
            }

            if (payload.type === "deploy:start" && payload.id !== watching) {
                toast(payload.project + ": deploy started", "info", 2600);
            }

            refresh();
        };
    }

    // The fleet page reflects a daemon that changes without telling anyone, so
    // it polls on top of the event stream.
    function initAutoRefresh() {
        var host = $("[data-refresh]");
        if (!host || host.dataset.bound) return;
        host.dataset.bound = "1";

        var seconds = Number(host.getAttribute("data-refresh")) || 10;
        setInterval(function () { if (!document.hidden) refresh(); }, seconds * 1000);
    }

    // ---------------------------------------------------------------- boot

    function init() {
        tickTimes();
        initChrome();
        initBuckets();
        initFilters();
        initConfirm();
        initCopy();
        initSecrets();
        initLog();
        initContainerStream();
        initPalette();
        initAutoRefresh();
    }

    init();
    initFlash();
    connect();

    setInterval(tickTimes, 10000);

    window.nimbus2k = { toast: toast, refresh: refresh };
})();
