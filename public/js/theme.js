/*
 * Loaded synchronously in <head> and deliberately tiny: it runs before the
 * first paint so a stored dark/light choice never shows up as a flash of the
 * other theme. Everything else lives in app.js.
 */
(function () {
    "use strict";

    var KEY = "nimbus2k.theme";

    try {
        var stored = localStorage.getItem(KEY);
        // "system" is stored as the absence of the attribute, which lets the
        // prefers-color-scheme block in tokens.css take over.
        if (stored === "dark" || stored === "light") {
            document.documentElement.setAttribute("data-theme", stored);
        }

        if (localStorage.getItem("nimbus2k.sidebar") === "collapsed") {
            document.documentElement.setAttribute("data-sidebar", "collapsed");
        }
    } catch (err) {
        // Private mode with storage disabled; the default theme is fine.
    }
})();
