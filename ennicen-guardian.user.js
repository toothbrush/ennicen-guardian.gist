// ==UserScript==
// @name         ennicen-guardian
// @namespace    https://github.com/toothbrush/ennicen-guardian.gist
// @updateURL    https://raw.githubusercontent.com/toothbrush/ennicen-guardian.gist/main/ennicen-guardian.user.js
// @downloadURL  https://raw.githubusercontent.com/toothbrush/ennicen-guardian.gist/main/ennicen-guardian.user.js
// @version      0.17
// @description  block junk
// @author       toothbrush
// @match        https://www.theguardian.com/*
// @exclude      https://www.theguardian.com/commentisfree/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM.xmlHttpRequest
// @connect      api.github.com
// @connect      raw.githubusercontent.com
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
 * To zap: hover any large block; floating [mute]/[keep] pills snap to the
 * nearest block with a *stable* identifier and highlight it (that's your
 * preview). [mute] hides it everywhere and commits the selector to rules.txt.
 * [keep] writes a `keep:` line so the picker stops offering that block.
 *
 * To enable zapping on this device: Tampermonkey menu -> "Set GitHub token...".
 * Use a fine-grained PAT scoped to this repo's *Contents: read/write only* with
 * an expiry. Stored in GM storage (sandboxed to this script), never in the repo.
 * Mobile stays read-only (no token there).
 */

const REPO = "toothbrush/ennicen-guardian.gist";
const BRANCH = "main";
const RULES_FILENAME = "rules.txt";
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${RULES_FILENAME}`;
const API_URL = `https://api.github.com/repos/${REPO}/contents/${RULES_FILENAME}`;
const CACHE_TTL_MS = 5 * 60 * 1000;

const TOKEN_KEY = "gh_gist_token";
const HOVER_KEY = "hover_mute_enabled";
const CACHE_KEY = "rules_cache";
const CACHE_TS_KEY = "rules_cache_ts";

let syncedSet = new Set();
let keepSet = new Set();   // selectors the picker should stop offering ("keep" pill)

const boring_topics = [ // list of regexen
    /\bDuchess\b/,
    /\bDuke\b/,
    /\bElon\b/,
    /\bJoe Rogan\b/,
    /\bPrince Harry\b/,
    /\bPrince William\b/,
    /\bRoyal\b/,
    /\bTwitter\b/,
    /\bfootball\b/,
    /\bfootballer\b/,
    /\bWorld Cup\b/,
];

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

/* ---------- GM API shims (degrade gracefully on hosts missing an API) ---------- */

function gmGet(key, def) {
    try { if (typeof GM_getValue === "function") return GM_getValue(key, def); } catch (e) {}
    return def;
}
function gmSet(key, val) {
    try { if (typeof GM_setValue === "function") GM_setValue(key, val); } catch (e) {}
}
function gmDelete(key) {
    try { if (typeof GM_deleteValue === "function") GM_deleteValue(key); } catch (e) {}
}
function gmXhr(details) {
    if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest(details);
    if (typeof GM !== "undefined" && GM && GM.xmlHttpRequest) return GM.xmlHttpRequest(details);
    return null;
}

function getToken() { return gmGet(TOKEN_KEY, ""); }
function canWrite() { return !!getToken(); }
function hoverMuteEnabled() { return gmGet(HOVER_KEY, true); }

/* ---------- rules file: parse / cache / apply ---------- */

// Returns { mute, keep }. A bare selector is a hide rule; `keep: <selector>`
// marks a selector the picker should stop offering.
function parseRules(text) {
    const mute = [], keep = [];
    text.split("\n").forEach(function (raw) {
        const line = raw.replace(/#.*$/, "").trim(); // strip inline `# comment`
        if (!line) return;
        const m = line.match(/^keep:\s*(.+)$/);
        if (m) keep.push(m[1].trim());
        else mute.push(line);
    });
    return { mute: mute, keep: keep };
}

function cacheRules(content) {
    gmSet(CACHE_KEY, content);
    gmSet(CACHE_TS_KEY, Date.now());
}

function applyRules(content) {
    const parsed = parseRules(content);
    syncedSet = new Set(parsed.mute);
    keepSet = new Set(parsed.keep);
    rebuildSyncedStyle();
}

function loadEffectiveRules() {
    applyRules(gmGet(CACHE_KEY, ""));
}

function refreshIfStale() {
    if (Date.now() - gmGet(CACHE_TS_KEY, 0) < CACHE_TTL_MS) return;
    gmXhr({
        method: "GET",
        url: RAW_URL,
        onload: function (res) {
            if (res.status >= 200 && res.status < 300) {
                cacheRules(res.responseText);
                applyRules(res.responseText); // use fetched content directly; storage may be a no-op
            }
        },
    });
}

/* ---------- synced hides (reversible: one rebuildable <style>) ---------- */

let syncedStyleEl = null;

function rebuildSyncedStyle() {
    if (!syncedStyleEl) {
        syncedStyleEl = document.createElement("style");
        syncedStyleEl.id = "ennicen-synced-hide";
        document.head.appendChild(syncedStyleEl);
    }
    const selectors = [...syncedSet];
    syncedStyleEl.textContent = selectors.length ? selectors.join(",\n") + " { display: none !important; }" : "";
}

/* ---------- GitHub API (write path) ---------- */

function ghApi(method, body, cb) {
    gmXhr({
        method: method,
        url: API_URL,
        headers: {
            "Authorization": "Bearer " + getToken(),
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: function (res) {
            if (res.status >= 200 && res.status < 300) {
                try { cb(null, JSON.parse(res.responseText)); }
                catch (e) { cb(new Error("bad JSON from GitHub")); }
            } else {
                const e = new Error("GitHub " + res.status);
                e.status = res.status;
                cb(e);
            }
        },
        onerror: function () { cb(new Error("network error")); },
    });
}

// UTF-8-safe base64 (GET ships file bodies base64-encoded with newlines every
// 60 chars that must be stripped before decode).
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(b64) { return decodeURIComponent(escape(atob(b64.replace(/\n/g, "")))); }

// GET authoritative content+sha -> transform -> PUT with a commit message.
// transform returns null to skip the write. The PUT's optimistic-concurrency sha
// guards against clobbering a write from another device between GET and PUT; a
// 409 means our sha went stale (a concurrent write landed), so we re-GET and
// re-run the transform against fresh content rather than clobber it.
const MUTATE_MAX_RETRIES = 4;
function mutateRules(message, transform, cb, attempt) {
    attempt = attempt || 0;
    ghApi("GET", null, function (err, file) {
        if (err) return cb(err);
        const content = file && file.content ? b64decode(file.content) : "";
        const newContent = transform(content);
        if (newContent === null) return cb(null);
        const body = {
            message: message,
            content: b64encode(newContent),
            branch: BRANCH,
        };
        if (file && file.sha) body.sha = file.sha; // omit only when creating the file
        ghApi("PUT", body, function (err2) {
            if (err2) {
                if (err2.status === 409 && attempt < MUTATE_MAX_RETRIES) {
                    setTimeout(function () { mutateRules(message, transform, cb, attempt + 1); }, 250 * (attempt + 1));
                    return;
                }
                return cb(err2);
            }
            cacheRules(newContent);
            cb(null);
        });
    });
}

function appendRule(selector, cb) {
    mutateRules("rules.txt: Add " + selector, function (content) {
        if (parseRules(content).mute.includes(selector)) return null; // already present
        const lines = content.replace(/\n+$/, "").split("\n");
        lines.push(selector);
        return lines.join("\n") + "\n";
    }, cb);
}

function removeRule(selector, cb) {
    mutateRules("rules.txt: Remove " + selector, function (content) {
        return content.split("\n").filter(function (line) {
            return line.replace(/#.*$/, "").trim() !== selector;
        }).join("\n");
    }, cb);
}

function appendKeep(selector, cb) {
    const entry = "keep: " + selector;
    mutateRules("rules.txt: Keep " + selector, function (content) {
        if (parseRules(content).keep.includes(selector)) return null; // already kept
        const lines = content.replace(/\n+$/, "").split("\n");
        lines.push(entry);
        return lines.join("\n") + "\n";
    }, cb);
}

function removeKeep(selector, cb) {
    mutateRules("rules.txt: Unkeep " + selector, function (content) {
        return content.split("\n").filter(function (line) {
            const m = line.replace(/#.*$/, "").trim().match(/^keep:\s*(.+)$/);
            return !(m && m[1].trim() === selector);
        }).join("\n");
    }, cb);
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

let highlightEl = null, muteBtn = null, keepBtn = null, muteName = null, keepName = null;
let currentSelector = null, hideTimer = null, rafPending = false;

function pillStyle(bg) {
    return "position:fixed;z-index:2147483647;display:none;cursor:pointer;color:#fff;border:none;" +
        "border-radius:4px;padding:4px 8px;font:bold 12px/1.3 sans-serif;text-align:center;" +
        "white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.4);background:" + bg + ";";
}

// Build a pill with a fixed label line and a second line for the selector name.
function buildPill(label, bg, onClick) {
    const btn = document.createElement("button");
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
    highlightEl.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;" +
        "border:2px solid #c70000;background:rgba(199,0,0,.12);box-sizing:border-box;display:none;";
    document.body.appendChild(highlightEl);

    const mute = buildPill("✕ mute", "#c70000", function () { muteSelector(currentSelector); });
    muteBtn = mute.btn; muteName = mute.name;

    const keep = buildPill("✓ keep", "#1a7f37", function () { keepSelector(currentSelector); });
    keepBtn = keep.btn; keepName = keep.name;
}

function showAffordanceFor(el, sel) {
    clearTimeout(hideTimer);
    currentSelector = sel;
    const r = el.getBoundingClientRect();
    highlightEl.style.top = r.top + "px";
    highlightEl.style.left = r.left + "px";
    highlightEl.style.width = r.width + "px";
    highlightEl.style.height = r.height + "px";
    highlightEl.style.display = "block";

    // Both pills right-aligned to the block's right edge, stacked: mute, then keep.
    muteName.textContent = sel;
    keepName.textContent = sel;
    const right = Math.max(2, window.innerWidth - r.right) + "px";
    const top = Math.max(2, r.top + 4);
    muteBtn.style.left = "auto";
    muteBtn.style.right = right;
    muteBtn.style.top = top + "px";
    muteBtn.style.display = "block";
    keepBtn.style.left = "auto";
    keepBtn.style.right = right;
    keepBtn.style.top = (top + muteBtn.offsetHeight + 4) + "px"; // offsetHeight valid now it's shown
    keepBtn.style.display = "block";
}

function hideAffordance() {
    if (!highlightEl) return;
    highlightEl.style.display = "none";
    muteBtn.style.display = "none";
    keepBtn.style.display = "none";
    currentSelector = null;
}

function onMouseMove(e) {
    if (e.target === muteBtn || e.target === keepBtn) return; // hovering a pill: keep current
    if (rafPending) return;
    rafPending = true;
    const target = e.target;
    requestAnimationFrame(function () {
        rafPending = false;
        const cand = findCandidate(target);
        if (cand) showAffordanceFor(cand.el, cand.sel);
        else { clearTimeout(hideTimer); hideTimer = setTimeout(hideAffordance, 150); }
    });
}

function onScrollOrResize() { hideAffordance(); } // rects go stale on scroll; reappears on next move

function enableHoverMute() {
    if (!canWrite()) return;
    ensureAffordance();
    document.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize, true);
}

function disableHoverMute() {
    document.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize, true);
    hideAffordance();
}

/* ---------- toast / undo ---------- */

let toastEl = null, toastTimer = null;

function showToast(msg, actionLabel, actionFn) {
    if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);" +
            "z-index:2147483647;background:#222;color:#fff;padding:10px 14px;border-radius:6px;" +
            "font:14px/1.3 sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);max-width:90vw;";
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg + " ";
    if (actionLabel && actionFn) {
        const a = document.createElement("a");
        a.textContent = actionLabel;
        a.href = "javascript:void(0)";
        a.style.cssText = "color:#6cf;margin-left:8px;cursor:pointer;font-weight:bold;";
        a.addEventListener("click", function (e) { e.preventDefault(); hideToast(); actionFn(); });
        toastEl.appendChild(a);
    }
    toastEl.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
}

function hideToast() { if (toastEl) toastEl.style.display = "none"; }

/* ---------- menu commands ---------- */

function registerMenu(label, fn) {
    if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand(label, fn);
}

registerMenu("Set GitHub token…", function () {
    const t = prompt("Fine-grained PAT, scoped to this repo's Contents: read/write ONLY. Blank to clear:", getToken());
    if (t === null) return;
    const trimmed = t.trim();
    if (!trimmed) { gmDelete(TOKEN_KEY); disableHoverMute(); alert("Token cleared. Mute pill hidden on this device."); return; }
    gmSet(TOKEN_KEY, trimmed);
    ghApi("GET", null, function (err, file) { // validate at entry, not every page load
        if (err) { alert("⚠ Token saved but validation failed: " + err.message); return; }
        const ok = file && file.content;
        if (ok) { enableHoverMute(); alert("Token works. Hover a block to see the mute pill."); }
        else alert("Token works, but '" + RULES_FILENAME + "' isn't in the repo yet — create it first.");
    });
});

registerMenu("Toggle hover-mute pill", function () {
    const next = !hoverMuteEnabled();
    gmSet(HOVER_KEY, next);
    if (next) { enableHoverMute(); alert("Hover-mute pill ON."); }
    else { disableHoverMute(); alert("Hover-mute pill OFF."); }
});

/* ---------- static, hand-curated hides + boring-topic filtering ---------- */

(function staticHides() {
    'use strict';
    console.log("Hi Guardian");
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

    var athings = document.getElementsByClassName("fc-item__container");

    [].forEach.call(athings, function (thing) {
        var actual_title = (thing.innerText || thing.textContent);

        var is_boring = false;
        [].forEach.call(boring_topics, function (topic) {
            if(actual_title.match(topic)) {
                is_boring = true;
            }
        });

        if(is_boring) {
            thing.classList.add("paul_hide");
            thing.parentNode.style.backgroundColor = "blue";
            thing.parentNode.style.opacity = 0;
        };
    });

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
})();

/* ---------- boot ---------- */

loadEffectiveRules();   // synchronous, from cache: hide immediately, no flash
refreshIfStale();       // async: pull latest rules.txt, re-apply
if (canWrite() && hoverMuteEnabled()) enableHoverMute();
