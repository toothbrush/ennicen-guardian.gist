// ==UserScript==
// @name         ennicen-guardian
// @namespace    https://gist.github.com/toothbrush/f7426d7fbb46e621bf1aa4146af64cf8
// @updateURL    https://gist.githubusercontent.com/toothbrush/f7426d7fbb46e621bf1aa4146af64cf8/raw/ennicen-guardian.user.js
// @downloadURL  https://gist.githubusercontent.com/toothbrush/f7426d7fbb46e621bf1aa4146af64cf8/raw/ennicen-guardian.user.js
// @version      0.7
// @description  block junk
// @author       toothbrush
// @match        https://www.theguardian.com/*
// @exclude      https://www.theguardian.com/commentisfree/*
// @run-at       document-idle
// ==/UserScript==

const boring_topics = [ // list of regexen
    /\bElon\b/,
    /\bJoe Rogan\b/,
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

(function() {
    'use strict';
    console.log("Hi Guardian");
    GM_addStyle(paul_hide);
    GM_addStyle("#sport { display: none; }");
    GM_addStyle(".morning-mail-thrasher__layout { display: none; }");
    GM_addStyle("#guardian-labs { display: none; }");
    GM_addStyle("#coronavirus-data { display: none; }");
    GM_addStyle("#world-cup-2022 { display: none; }");
    GM_addStyle(".thrasher-inner { display: none; }");

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
