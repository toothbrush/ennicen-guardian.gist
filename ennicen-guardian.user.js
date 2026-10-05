// ==UserScript==
// @name         ennicen-guardian
// @namespace    https://github.com/toothbrush/ennicen-guardian.gist
// @updateURL    https://raw.githack.com/toothbrush/ennicen-guardian.gist/main/ennicen-guardian.user.js
// @downloadURL  https://raw.githack.com/toothbrush/ennicen-guardian.gist/main/ennicen-guardian.user.js
// @version      0.37
// @description  block junk
// @author       toothbrush
// @match        https://www.theguardian.com/*
// @exclude      https://www.theguardian.com/commentisfree/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM.xmlHttpRequest
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @require      https://raw.githubusercontent.com/toothbrush/userscript-lib.gist/v4/synced-list.js
// @require      https://raw.githubusercontent.com/toothbrush/userscript-lib.gist/v4/no-hscroll.js
// @run-at       document-idle
// ==/UserScript==

/*
 * Two kinds of hides live here:
 *   1. Static, hand-curated rules — inline below in the IIFE (GM_addStyle calls).
 *   2. Zapped rules — CSS selectors in a separate plain-text file (rules.txt) in
 *      this repo. Every device reads rules.txt (unauthenticated, via raw.github);
 *      only devices with a GitHub token configured can append to it. Each append
 *      is a real commit via the Contents API.
 *
 * To zap: hold ⌥ (Option/Alt) and [mute]/[keep] pills appear for the nearest
 * block under the cursor that has a *stable* identifier, highlighting it (that's
 * your preview). Release ⌥ and the box stays so you can click a pill; press ⌥
 * again over a nested element to retarget the innermost block. [mute] hides the
 * block everywhere and commits its selector to rules.txt; [keep] writes a
 * `keep:` line so the picker stops offering that block. Esc dismisses.
 *
 * To enable zapping on this device: Tampermonkey menu -> "Set GitHub token...".
 * Use a fine-grained PAT scoped to this repo's *Contents: read/write only* with
 * an expiry. Stored in GM storage (sandboxed to this script), never in the repo.
 * Mobile stays read-only (no token there).
 */

// rules.txt lives in this repo. synced-list.js (shared with BOW-killfile,
// loaded with @require, pinned to a tag) does the raw.github read, the
// Contents API write, the GM shims, the toast and the token menu.
const rules = new SyncedFile({
    repo: "toothbrush/ennicen-guardian.gist",
    file: "rules.txt",
    cacheKey: "rules_cache",    // the keys older versions used, so a device keeps its cache
    tokenKey: "gh_gist_token",  // and its token across the move to the library
    tag: "ennicen",
});
const HOVER_KEY = "hover_mute_enabled";

let syncedSet = new Set();
let keepSet = new Set();   // selectors the picker should stop offering ("keep" pill)

// Boring-topic regexen, sourced from `boring: <regex>` lines in rules.txt and
// compiled at apply-time. A headline whose text matches any of these is hidden.
let boringList = [];

const paul_hide = `.paul_hide { background: purple !important; visibility: hidden !important; }`

function GM_addStyle(css) {
  const style = document.getElementById("GM_addStyleBy8626") || (function() {
    const style = document.createElement('style');
    style.type = 'text/css';
    style.id = "GM_addStyleBy8626";
    document.head.appendChild(style);
    return style;
  })();
  const sheet = style.sheet;
  sheet.insertRule(css, (sheet.rules || sheet.cssRules || []).length);
}

function canWrite() { return rules.canWrite(); }
function hoverMuteEnabled() { return gmGet(HOVER_KEY, true); }

/* ---------- rules file: parse / cache / apply ---------- */

// Returns { mute, keep, boring }. A bare selector is a hide rule; `keep: <selector>`
// marks a selector the picker should stop offering; `boring: <regex>` is a headline
// text filter (the part after the colon is a JS regex source).
function parseRules(text) {
    const mute = [], keep = [], boring = [];
    text.split("\n").forEach(function (raw) {
        const line = stripComment(raw);
        if (!line) return;
        let m;
        if ((m = line.match(/^keep:\s*(.+)$/))) keep.push(m[1].trim());
        else if ((m = line.match(/^boring:\s*(.+)$/))) boring.push(m[1].trim());
        else mute.push(line);
    });
    return { mute: mute, keep: keep, boring: boring };
}

function compileBoring(sources) {
    const out = [];
    sources.forEach(function (src) {
        try { out.push(new RegExp(src)); }
        catch (e) { console.warn("[ennicen] ignoring bad boring regex: " + src, e); }
    });
    return out;
}

// Hide headline cards whose text matches any boring-topic regex. Idempotent, so
// it's safe to re-run on every rules apply (cache load + async refresh).
function applyBoringFilter() {
    if (!boringList.length) return;
    const isBoring = function (text) {
        return !!text && boringList.some(function (topic) { return topic.test(text); });
    };
    // Old-frontend markup: the whole card is one .fc-item__container.
    [].forEach.call(document.getElementsByClassName("fc-item__container"), function (thing) {
        if (isBoring(thing.innerText || thing.textContent)) {
            thing.classList.add("paul_hide");
            thing.parentNode.style.backgroundColor = "blue";
            thing.parentNode.style.opacity = 0;
        }
    });
    // DCR markup: only the headline (kicker + text) carries a stable class; the
    // enclosing <li> is the whole card (or sublink row), so hide that instead.
    [].forEach.call(document.querySelectorAll(".card-headline, .card-sublink-headline"), function (h) {
        if (!isBoring(h.innerText || h.textContent)) return;
        (h.closest("li") || h).style.setProperty("display", "none", "important");
    });
}

function applyRules(content) {
    const parsed = parseRules(content);
    syncedSet = new Set(parsed.mute);
    keepSet = new Set(parsed.keep);
    boringList = compileBoring(parsed.boring);
    rebuildSyncedStyle();
    applyBoringFilter();
}

// A fetch that fails shows on the page: there may be no console on this device.
rules.onError = function (msg) { showDebug(msg); };

/* ---------- synced hides (reversible: one rebuildable <style>) ---------- */

let syncedStyleEl = null;

function rebuildSyncedStyle() {
    if (!syncedStyleEl) {
        syncedStyleEl = document.createElement("style");
        syncedStyleEl.id = "ennicen-synced-hide";
        document.head.appendChild(syncedStyleEl);
    }
    // One rule per selector (not a single comma-joined group): a browser drops a
    // whole selector group if any one member is invalid, so an unparseable line
    // would otherwise take down every hide. Per-rule, only the bad one is dropped.
    const selectors = [...syncedSet];
    syncedStyleEl.textContent = selectors
        .map(function (s) { return s + " { display: none !important; }"; })
        .join("\n");
}

/* ---------- rules.txt edits: one commit each, via the library ---------- */

function appendRule(selector, cb) { rules.appendLine(selector, "rules.txt: Add " + selector, cb); }
function removeRule(selector, cb) { rules.removeLine(selector, "rules.txt: Remove " + selector, cb); }
function appendKeep(selector, cb) { rules.appendLine("keep: " + selector, "rules.txt: Keep " + selector, cb); }
function removeKeep(selector, cb) {
    rules.removeLine(function (line) {
        const m = line.match(/^keep:\s*(.+)$/);
        return !!m && m[1].trim() === selector;
    }, "rules.txt: Unkeep " + selector, cb);
}

/* ---------- mute / unmute ---------- */

function muteSelector(selector) {
    if (!selector || syncedSet.has(selector)) return;
    syncedSet.add(selector);   // optimistic
    rebuildSyncedStyle();
    hideAffordance();
    appendRule(selector, function (err) {
        if (err) {
            syncedSet.delete(selector); // revert: not actually synced
            rebuildSyncedStyle();
            showToast("⚠ couldn't mute " + selector + ": " + err.message);
        } else {
            showToast("Muted " + selector, "undo", function () { unmuteSelector(selector); });
        }
    });
}

function unmuteSelector(selector) {
    removeRule(selector, function (err) {
        if (err) { showToast("⚠ couldn't restore " + selector + ": " + err.message); return; }
        syncedSet.delete(selector);
        rebuildSyncedStyle();
        showToast("Restored " + selector);
    });
}

function keepSelector(selector) {
    if (!selector || keepSet.has(selector)) return;
    keepSet.add(selector);   // optimistic: picker stops offering it immediately
    hideAffordance();
    appendKeep(selector, function (err) {
        if (err) {
            keepSet.delete(selector); // revert: not actually synced
            showToast("⚠ couldn't keep " + selector + ": " + err.message);
        } else {
            showToast("Won't offer " + selector + " again", "undo", function () { unkeepSelector(selector); });
        }
    });
}

function unkeepSelector(selector) {
    removeKeep(selector, function (err) {
        if (err) { showToast("⚠ couldn't unkeep " + selector + ": " + err.message); return; }
        keepSet.delete(selector);
        showToast("Will offer " + selector + " again");
    });
}

/* ---------- durable selector generation ----------
 * The Guardian's dcr- and css- class names are per-deploy hashes — useless as
 * rules. Walk up from the clicked node and emit the FIRST selector built from a
 * stable hook: <gu-island name>, id, or a data-* attribute, else a non-hashed
 * class. Returns null if nothing stable is in reach. */

function cssAttrVal(v) { return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function isStableClass(c) { return c && !/^dcr-/.test(c) && !/^css-/.test(c) && !/^sc-/.test(c); }

function stableSelectorFor(el) {
    if (!el || !el.tagName) return null;
    const tag = el.tagName.toLowerCase();
    if (tag === "gu-island") {
        const n = el.getAttribute("name");
        if (n) return `gu-island[name='${cssAttrVal(n)}']`;
    }
    if (el.id) return `${tag}#${CSS.escape(el.id)}`;
    for (const a of ["data-component", "data-gu-name", "data-spacefinder-type", "data-link-name"]) {
        const v = el.getAttribute(a);
        if (v) return `${tag}[${a}='${cssAttrVal(v)}']`;
    }
    const cls = [].filter.call(el.classList, isStableClass);
    if (cls.length) return `${tag}.${cls.map(CSS.escape).join(".")}`;
    return null;
}

function isLargeEnough(el) {
    const r = el.getBoundingClientRect();
    return r.width >= 200 && r.height >= 60;
}

// Nearest ancestor (incl. self) that is both stably-selectable and a large block.
function findCandidate(start) {
    let el = start;
    for (let d = 0; el && el !== document.body && d < 14; d++, el = el.parentElement) {
        if (el === muteBtn || el === keepBtn || el === highlightEl) continue;
        const sel = stableSelectorFor(el);
        if (sel && isLargeEnough(el) && !keepSet.has(sel)) return { el: el, sel: sel };
    }
    return null;
}

/* ---------- hover affordance: highlight + floating [mute] pill ---------- */

let highlightEl = null, muteBtn = null, keepBtn = null, muteName = null, keepName = null, badgeEl = null;
let currentSelector = null, currentTargetEl = null, hideTimer = null, rafPending = false;
let lastX = -1, lastY = -1;

// Marks our own overlays so pixeltimes leaves them in a smooth font.
const IGNORE_CLASS = "pixelfont-ignore";

function pillStyle(bg) {
    return "position:fixed;z-index:2147483647;display:none;cursor:pointer;color:#fff;border:none;" +
        "border-radius:4px;padding:4px 8px;font:bold 12px/1.3 sans-serif;text-align:center;" +
        "white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.4);background:" + bg + ";";
}

// Build a pill with a fixed label line and a second line for the selector name.
function buildPill(label, bg, onClick) {
    const btn = document.createElement("button");
    btn.classList.add(IGNORE_CLASS);
    btn.style.cssText = pillStyle(bg);
    btn.appendChild(document.createTextNode(label));
    btn.appendChild(document.createElement("br"));
    const name = document.createElement("span");
    name.style.cssText = "font-weight:normal;font-size:11px;opacity:.95;";
    btn.appendChild(name);
    btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onClick(); });
    document.body.appendChild(btn);
    return { btn: btn, name: name };
}

function ensureAffordance() {
    if (highlightEl) return;
    highlightEl = document.createElement("div");
    highlightEl.classList.add(IGNORE_CLASS);
    highlightEl.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;" +
        "border:2px solid #c70000;background:rgba(199,0,0,.12);box-sizing:border-box;display:none;";
    document.body.appendChild(highlightEl);

    const mute = buildPill("✕ mute", "#c70000", function () { muteSelector(currentSelector); });
    muteBtn = mute.btn; muteName = mute.name;

    const keep = buildPill("✓ keep", "#1a7f37", function () { keepSelector(currentSelector); });
    keepBtn = keep.btn; keepName = keep.name;
}

// Unfussy, click-through status chip in the top-left corner.
function ensureBadge() {
    if (badgeEl) return;
    badgeEl = document.createElement("div");
    badgeEl.classList.add(IGNORE_CLASS);
    badgeEl.textContent = "ennicen-guardian active · hold ⌥ to zap";
    badgeEl.style.cssText = "position:fixed;top:8px;left:8px;z-index:2147483640;pointer-events:none;" +
        "background:rgba(0,0,0,.45);color:#fff;padding:6px 9px;border-radius:6px;" +
        "font:11px/1.3 sans-serif;opacity:.7;max-width:150px;display:none;";
    document.body.appendChild(badgeEl);
}

function ownUi(el) {
    return el === muteBtn || el === keepBtn || el === highlightEl || el === badgeEl ||
        (muteBtn && muteBtn.contains(el)) || (keepBtn && keepBtn.contains(el));
}

// Topmost page element at a point, ignoring our own overlay/pills.
function topPageElementAt(x, y) {
    if (x < 0 || y < 0) return null;
    const els = document.elementsFromPoint(x, y);
    for (let i = 0; i < els.length; i++) { if (!ownUi(els[i])) return els[i]; }
    return null;
}

// Lay the highlight + pills onto the current target's current rect. Cheap enough
// to call on scroll; reads currentTargetEl so positions track the block.
function repositionAffordance() {
    if (!currentTargetEl) return;
    const r = currentTargetEl.getBoundingClientRect();
    highlightEl.style.top = r.top + "px";
    highlightEl.style.left = r.left + "px";
    highlightEl.style.width = r.width + "px";
    highlightEl.style.height = r.height + "px";

    // Both pills right-aligned to the block's right edge, stacked: mute, then keep.
    const right = Math.max(2, window.innerWidth - r.right) + "px";
    const top = Math.max(2, r.top + 4);
    muteBtn.style.left = "auto";
    muteBtn.style.right = right;
    muteBtn.style.top = top + "px";
    keepBtn.style.left = "auto";
    keepBtn.style.right = right;
    keepBtn.style.top = (top + muteBtn.offsetHeight + 4) + "px"; // offsetHeight valid now it's shown
}

function showAffordanceFor(el, sel) {
    clearTimeout(hideTimer);
    currentTargetEl = el;
    currentSelector = sel;
    muteName.textContent = sel;
    keepName.textContent = sel;
    highlightEl.style.display = "block";
    muteBtn.style.display = "block";
    keepBtn.style.display = "block";
    repositionAffordance();
}

function hideAffordance() {
    if (!highlightEl) return;
    highlightEl.style.display = "none";
    muteBtn.style.display = "none";
    keepBtn.style.display = "none";
    currentSelector = null;
    currentTargetEl = null;
}

function pointInRect(x, y, r) {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function onMouseMove(e) {
    lastX = e.clientX; lastY = e.clientY;
    if (e.target === muteBtn || e.target === keepBtn) { clearTimeout(hideTimer); return; } // over a pill
    if (!e.altKey) return; // pills only track while ⌥ is held; otherwise leave them as-is
    // Stay locked to the current block while the cursor remains inside it (the
    // pills sit in its top-right corner, so reaching them keeps us inside). This
    // is what stops the jitter — we only retarget when the cursor actually leaves.
    if (currentTargetEl && currentTargetEl.isConnected &&
        pointInRect(e.clientX, e.clientY, currentTargetEl.getBoundingClientRect())) {
        clearTimeout(hideTimer);
        return;
    }
    if (rafPending) return;
    rafPending = true;
    const target = e.target;
    requestAnimationFrame(function () {
        rafPending = false;
        const cand = findCandidate(target);
        if (cand) { if (cand.el !== currentTargetEl) showAffordanceFor(cand.el, cand.sel); }
        else { clearTimeout(hideTimer); hideTimer = setTimeout(hideAffordance, 200); }
    });
}

function onKeyDown(e) {
    if (e.key === "Escape") { hideAffordance(); return; }
    // A fresh ⌥ press (re)targets the innermost block under the cursor, bypassing
    // the lock — release and press again to drill into a nested block.
    if (e.key === "Alt" || (e.code && e.code.indexOf("Alt") === 0)) {
        const el = topPageElementAt(lastX, lastY);
        const cand = el ? findCandidate(el) : null;
        if (cand) showAffordanceFor(cand.el, cand.sel);
    }
}

// Click on the page (not a pill) dismisses the frozen box; the pill's own
// handler stops propagation, so a pill click acts instead of dismissing.
function onDocClick(e) {
    if (currentTargetEl && !ownUi(e.target)) hideAffordance();
}

// Keep the pills pinned to the block as the page scrolls, rather than flickering
// off; drop them only if the block scrolls fully out of view.
function onScrollOrResize() {
    if (!currentTargetEl) return;
    if (!currentTargetEl.isConnected) { hideAffordance(); return; }
    const r = currentTargetEl.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) hideAffordance();
    else repositionAffordance();
}

function enableHoverMute() {
    if (!canWrite()) return;
    ensureAffordance();
    ensureBadge();
    badgeEl.style.display = "block";
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onDocClick, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize, true);
}

function disableHoverMute() {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("click", onDocClick, true);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize, true);
    hideAffordance();
    if (badgeEl) badgeEl.style.display = "none";
}

/* ---------- on-page debug banner ----------
 * A visible fallback for devices where you can't attach a console (e.g. iOS).
 * Self-contained: builds its own DOM, no GM APIs, so it shows even when the
 * rest of the script's plumbing is unavailable. Tap to dismiss. */

var debugEl = null; // var, not let: showDebug is hoisted and may run from the earlier staticHides IIFE

function showDebug(msg) {
    if (!debugEl) {
        debugEl = document.createElement("div");
        debugEl.classList.add(IGNORE_CLASS);
        debugEl.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
            "background:#b00020;color:#fff;padding:10px 14px;" +
            "font:bold 13px/1.4 -apple-system,sans-serif;text-align:center;cursor:pointer;" +
            "box-shadow:0 2px 8px rgba(0,0,0,.4);";
        debugEl.addEventListener("click", function () { debugEl.style.display = "none"; });
        document.body.appendChild(debugEl);
    }
    debugEl.textContent = "ennicen-guardian: " + msg + "  (tap to dismiss)";
    debugEl.style.display = "block";
}

/* ---------- menu commands ---------- */

// "Set GitHub token…": the zapper follows the token.
rules.registerTokenMenu(function () { enableHoverMute(); }, function () { disableHoverMute(); });

registerMenu("Toggle zapper (⌥ to zap)", function () {
    const next = !hoverMuteEnabled();
    gmSet(HOVER_KEY, next);
    if (next) { enableHoverMute(); alert("Zapper ON. Hold ⌥ over a block."); }
    else { disableHoverMute(); alert("Zapper OFF."); }
});

/* ---------- static, hand-curated hides + boring-topic filtering ---------- */

(function staticHides() {
  try {
    console.log("Hi Guardian");
    // Visible is-it-running indicator: periwinkle page background whenever active.
    GM_addStyle("body { background-color: #CCCCFF !important; }");
    // Synthesised dark mode: the site ships light-only CSS. Inverting <html>
    // keeps fixed-position pills working; media is inverted back. The root
    // background is inverted too, so #fff renders black.
    // The site pins color-scheme: light on :root; widen it so WebKit has no
    // reason to treat the page as light-only.
    GM_addStyle("@media (prefers-color-scheme: dark) { html { filter: invert(1) hue-rotate(180deg) !important; background: #fff !important; color-scheme: light dark !important; } }");
    GM_addStyle("@media (prefers-color-scheme: dark) { img, picture, video, iframe { filter: invert(1) hue-rotate(180deg) !important; } }");
    GM_addStyle(paul_hide);
    GM_addStyle("#sport { display: none; }");
    GM_addStyle(".morning-mail-thrasher__layout { display: none; }");
    GM_addStyle("#guardian-labs { display: none; }");
    GM_addStyle("#coronavirus-data { display: none; }");
    GM_addStyle("#world-cup-2022 { display: none; }");
    GM_addStyle("div.securedrop { display: none; }");
    GM_addStyle(".thrasher-inner { display: none; }");
    GM_addStyle(".the-rural-network { display: none; }");
    GM_addStyle("section#the-rural-network { display: none; }");
    GM_addStyle("header { display: none; }");
    GM_addStyle("footer { display: none; }");
    GM_addStyle("section#trending-topics { display: none; }");
    GM_addStyle("section#most-viewed-in-australia-news { display: none; }");
    GM_addStyle("section#most-viewed { display: none; }");
    GM_addStyle("section#video { display: none; }");
    GM_addStyle("section#videos { display: none; }");
    GM_addStyle("section#contact-the-guardian { display: none; }");
    GM_addStyle("gu-island[name='SubNav'] { display: none; }");
    GM_addStyle("div.gu-overlay { display: none; }");
    GM_addStyle("gu-island[name='AuEoy2024Wrapper'] { display: none; }");
    GM_addStyle("gu-island[name='StickyBottomBanner'] { display: none; }");

    // Boring-topic headline filtering now lives in applyBoringFilter(), driven by
    // `boring:` lines in rules.txt and run from applyRules() during boot.

    document.querySelectorAll(`[data-spacefinder-type='model.dotcomrendering.pageElements.NewsletterSignupBlockElement']`).forEach(element => {
        element.classList.add("paul_hide");
    });

    document.querySelectorAll(`[data-gu-name='standfirst']`).forEach(element => {
        element.classList.add("paul_hide");
    });

    document.querySelectorAll(`gu-island[name='SlotBodyEnd']`).forEach(element => {
        element.classList.add("paul_hide");
    });

    document.querySelectorAll(`gu-island[name='InteractiveBlockComponent']`).forEach(element => {
        element.classList.add("paul_hide");
    });
  } catch (e) {
    console.error("[ennicen] static hides threw:", e);
    showDebug("static hides failed: " + (e && e.message) + " — GM_addStyle/insertRule may be unsupported here");
  }
})();

/* ---------- boot ---------- */

// Read the version from GM_info so it never drifts from @version; "(unknown)"
// on hosts that don't expose GM_info (e.g. some iOS setups).
const VERSION = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "(unknown)";
console.log("[ennicen] boot v" + VERSION + " · " +
    "GM_addStyle styleEl=" + !!document.getElementById("GM_addStyleBy8626") + " · " +
    "GM_getValue=" + (typeof GM_getValue === "function") + " · " +
    "GM_xmlhttpRequest=" + (typeof GM_xmlhttpRequest === "function") + " · " +
    "GM.xmlHttpRequest=" + (typeof GM !== "undefined" && !!(GM && GM.xmlHttpRequest)) + " · " +
    "canWrite=" + canWrite());

rules.load(applyRules);   // from cache now (no flash), fresh rules.txt when stale
// Write path only — skipped on a token-less client (e.g. iOS), which read-applies above.
if (canWrite() && hoverMuteEnabled()) enableHoverMute();
