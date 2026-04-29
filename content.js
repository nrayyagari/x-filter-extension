(function () {
  const PROCESSED_ATTR = "data-xf-processed";
  const DEBUG = true;

  let settings = null;
  let debounceTimer = null;
  let observer = null;
  let periodicScanTimer = null;
  let initAttempts = 0;
  const MAX_INIT_ATTEMPTS = 10;

  function log(...args) {
    if (DEBUG) console.log("[X-Filter]", ...args);
  }
  function warn(...args) {
    if (DEBUG) console.warn("[X-Filter]", ...args);
  }

  // --- Settings Loading ---

  function init() {
    log("Initializing...");
    tryLoadSettings();
  }

  function tryLoadSettings() {
    initAttempts++;
    log(`Loading settings (attempt ${initAttempts}/${MAX_INIT_ATTEMPTS})...`);
    chrome.runtime.sendMessage({ type: "getSettings" }, (response) => {
      if (chrome.runtime.lastError) {
        warn("Settings load error:", chrome.runtime.lastError.message);
        if (initAttempts < MAX_INIT_ATTEMPTS) {
          setTimeout(tryLoadSettings, Math.min(500 * initAttempts, 3000));
        } else {
          warn("Max retries exceeded. Filtering disabled.");
        }
        return;
      }
      if (response?.settings) {
        settings = response.settings;
        log("Settings loaded. enabled=", settings.enabled);
        if (settings.enabled) {
          startFiltering();
        } else {
          log("Filtering disabled.");
        }
      } else {
        warn("No settings in response.");
        if (initAttempts < MAX_INIT_ATTEMPTS) {
          setTimeout(tryLoadSettings, Math.min(500 * initAttempts, 3000));
        }
      }
    });
  }

  // --- Message Handling ---

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "settingsUpdated") {
      log("settingsUpdated received");
      settings = message.data;
      if (settings.enabled) {
        reprocessAll();
        startFiltering();
      } else {
        stopFiltering();
        restoreAllHidden();
      }
      sendResponse?.({ received: true });
    }
    if (message.type === "forceScan") {
      log("forceScan received");
      if (settings?.enabled) {
        reprocessAll();
        processVisibleTweets();
      }
      sendResponse?.({ scanned: true, tweetCount: getVisibleTweets().length });
    }
    return true;
  });

  // --- DOM Observation ---

  function startFiltering() {
    processVisibleTweets();
    observeDOM();
    startPeriodicScan();
    showStatusIndicator();
  }

  function observeDOM() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        let hasNew = false;
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (isTweetElement(node) || node.querySelectorAll('article[data-testid="tweet"]').length > 0) {
              hasNew = true;
              break;
            }
          }
          if (hasNew) break;
        }
        if (hasNew) processVisibleTweets();
      }, 50);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    log("Observer started.");
  }

  function stopFiltering() {
    if (observer) { observer.disconnect(); observer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (periodicScanTimer) { clearInterval(periodicScanTimer); periodicScanTimer = null; }
    hideStatusIndicator();
  }

  function startPeriodicScan() {
    if (periodicScanTimer) clearInterval(periodicScanTimer);
    periodicScanTimer = setInterval(() => {
      if (settings?.enabled) {
        const unprocessed = getVisibleTweets().filter((t) => !t.getAttribute(PROCESSED_ATTR)).length;
        if (unprocessed > 0) {
          log(`Periodic scan: ${unprocessed} unprocessed.`);
          processVisibleTweets();
        }
        updateStatusIndicator();
      }
    }, 2000);
  }

  // --- Tweet Discovery ---

  function isTweetElement(el) {
    return el.matches && el.matches('article[data-testid="tweet"]');
  }

  function getVisibleTweets() {
    return Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  }

  function findTweetCell(tweetEl) {
    // X.com wraps tweets in div[data-testid="cellInnerDiv"]
    const cell = tweetEl.closest('div[data-testid="cellInnerDiv"]');
    if (cell) return cell;
    // Fallback: parent that contains only this tweet
    const parent = tweetEl.parentElement;
    if (parent && parent.children.length <= 2) return parent;
    return tweetEl.parentElement;
  }

  const BATCH_SIZE = 20;

  function processVisibleTweets() {
    const tweets = getVisibleTweets();
    if (tweets.length === 0) {
      log("No tweets found.");
      return;
    }
    let processed = 0, skipped = 0, hidden = 0;
    for (const tweet of tweets) {
      if (processed >= BATCH_SIZE) {
        setTimeout(processVisibleTweets, 100);
        break;
      }
      if (tweet.getAttribute(PROCESSED_ATTR)) { skipped++; continue; }
      if (processTweet(tweet)) hidden++;
      processed++;
    }
    if (processed > 0) {
      log(`Processed ${processed}, hidden ${hidden}, skipped ${skipped}. Total: ${tweets.length}`);
    }
  }

  function reprocessAll() {
    log("Reprocessing all...");
    getVisibleTweets().forEach((t) => {
      t.removeAttribute(PROCESSED_ATTR);
      findTweetCell(t).querySelectorAll(".xf-placeholder").forEach((p) => p.remove());
      t.style.display = "";
    });
    processVisibleTweets();
  }

  function restoreAllHidden() {
    getVisibleTweets().forEach((t) => {
      t.removeAttribute(PROCESSED_ATTR);
      findTweetCell(t).querySelectorAll(".xf-placeholder").forEach((p) => p.remove());
      t.style.display = "";
    });
  }

  function processTweet(tweetEl) {
    if (!settings || !settings.enabled) return false;
    tweetEl.setAttribute(PROCESSED_ATTR, "true");

    const data = extractTweetData(tweetEl);
    if (!data) {
      warn("extractTweetData failed.");
      return false;
    }

    const result = scoreTweet(data);
    if (result.hidden) {
      hideTweet(tweetEl, result.reason, data);
      log(`HIDDEN [${result.reason}] @${data.author || "?"}: "${data.text.substring(0, 50)}..."`);
      return true;
    }
    return false;
  }

  // --- Data Extraction (Robust) ---

  function extractTweetData(tweetEl) {
    const cell = findTweetCell(tweetEl);

    // Extract text: try multiple selectors
    let text = "";
    const textSelectors = [
      '[data-testid="tweetText"]',
      '[data-testid="cardText"]',
      'div[dir="auto"]',
      'div[lang]',
    ];
    for (const sel of textSelectors) {
      const el = tweetEl.querySelector(sel);
      if (el && el.textContent) {
        text = el.textContent.trim();
        if (text.length > 0) break;
      }
    }

    // If no direct child matches, look deeper for any text div
    if (!text) {
      const allTextDivs = tweetEl.querySelectorAll('div[dir="auto"]');
      for (const div of allTextDivs) {
        const t = div.textContent?.trim();
        if (t && t.length > text.length) text = t;
      }
    }

    // Extract author handle
    let authorHandle = "";
    const EXCLUDED = new Set(["home","explore","notifications","messages","i","search","settings","compose","login","logout","signup","intent","share","hashtag","translate"]);

    // Method 1: profile links
    for (const link of tweetEl.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href") || "";
      const parts = href.split("/").filter(Boolean);
      if (parts.length === 1 && !EXCLUDED.has(parts[0].toLowerCase())) {
        if (/^[a-zA-Z0-9_]{1,15}$/.test(parts[0])) {
          authorHandle = parts[0];
          break;
        }
      }
    }

    // Method 2: link text that looks like @handle
    if (!authorHandle) {
      for (const link of tweetEl.querySelectorAll('a[role="link"]')) {
        const txt = link.textContent?.trim() || "";
        if (txt.startsWith("@")) {
          authorHandle = txt.substring(1);
          break;
        }
      }
    }

    // Method 3: avatar alt
    if (!authorHandle) {
      const img = tweetEl.querySelector('img[alt^="@"]');
      if (img) {
        const alt = img.getAttribute("alt") || "";
        if (alt.startsWith("@")) authorHandle = alt.substring(1);
      }
    }

    // Method 4: span containing @handle
    if (!authorHandle) {
      for (const span of tweetEl.querySelectorAll("span")) {
        const txt = span.textContent?.trim() || "";
        if (/^@[a-zA-Z0-9_]{1,15}$/.test(txt)) {
          authorHandle = txt.substring(1);
          break;
        }
      }
    }

    // Hashtags
    const hashtags = [];
    tweetEl.querySelectorAll('a[href*="/hashtag/"]').forEach((el) => {
      const tag = el.textContent?.trim();
      if (tag) hashtags.push(tag);
    });

    return {
      text: text || "",
      author: authorHandle ? "@" + authorHandle : "",
      hashtags,
      element: tweetEl,
      cellElement: cell
    };
  }

  // --- Scoring ---

  function scoreTweet(data) {
    const { text, author, hashtags } = data;
    const lowerText = text.toLowerCase();

    if (author && settings.whitelistedAuthors?.includes(author)) {
      return { hidden: false, reason: "" };
    }

    if (Array.isArray(settings.techWhitelist)) {
      for (const term of settings.techWhitelist) {
        if (term.includes(" ")) {
          if (lowerText.includes(term.toLowerCase())) return { hidden: false, reason: "" };
        } else if (new RegExp("\\b" + escapeRegex(term.toLowerCase()) + "\\b").test(lowerText)) {
          return { hidden: false, reason: "" };
        }
      }
    }

    let score = 0, reason = "";

    if (settings.activeFilters?.political && Array.isArray(settings.keywords?.political)) {
      for (const kw of settings.keywords.political) {
        if (keywordMatch(lowerText, kw)) { score += 2; if (!reason) reason = "Political content"; }
      }
    }
    if (settings.activeFilters?.movies && Array.isArray(settings.keywords?.movies)) {
      for (const kw of settings.keywords.movies) {
        if (keywordMatch(lowerText, kw)) { score += 2; if (!reason) reason = "Movies & Gossip"; }
      }
    }
    if (settings.activeFilters?.sensationalism && Array.isArray(settings.keywords?.sensationalism)) {
      for (const kw of settings.keywords.sensationalism) {
        if (keywordMatch(lowerText, kw)) { score += 1; if (!reason && score >= 3) reason = "Sensationalism"; }
      }
    }

    if (Array.isArray(settings.learned?.authors) && settings.learned.authors.includes(author)) {
      score += 3; if (!reason) reason = "Learned author";
    }
    if (Array.isArray(settings.learned?.hashtags)) {
      for (const tag of hashtags) {
        if (settings.learned.hashtags.includes(tag)) { score += 2; if (!reason) reason = "Learned hashtag"; }
      }
    }
    if (Array.isArray(settings.learned?.keywords)) {
      for (const kw of settings.learned.keywords) {
        if (keywordMatch(lowerText, kw)) score += 1;
      }
    }

    return { hidden: score >= 3, reason: reason || "Filtered content", score };
  }

  // --- Placeholder UI ---

  function hideTweet(tweetEl, reason, data) {
    const cell = data.cellElement;
    if (!cell) return;

    // Clean old placeholders
    findTweetCell(tweetEl).querySelectorAll(".xf-placeholder").forEach((p) => p.remove());

    tweetEl.style.display = "none";

    const ph = document.createElement("div");
    ph.className = "xf-placeholder";
    ph.innerHTML = `
      <div class="xf-placeholder-inner">
        <div class="xf-icon-row">
          <span class="xf-filter-icon">&#x26A0;</span>
          <span class="xf-reason">${escapeHtml(reason)}</span>
        </div>
        <div class="xf-hint">Hover to reveal</div>
        <div class="xf-actions">
          <button class="xf-btn xf-btn-hide">Hide similar</button>
          <button class="xf-btn xf-btn-whitelist">&#x2714; Always show ${escapeHtml(data.author || "@author")}</button>
        </div>
      </div>
    `;

    const hideBtn = ph.querySelector(".xf-btn-hide");
    const wlBtn = ph.querySelector(".xf-btn-whitelist");

    if (!data.author) {
      wlBtn.disabled = true;
      wlBtn.textContent = "Author unavailable";
    }

    hideBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleHideSimilar(data);
      hideBtn.textContent = "Learned!";
      hideBtn.disabled = true;
      showToast("Pattern learned");
    });

    wlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!data.author) return;
      handleWhitelistAuthor(data, () => {
        wlBtn.textContent = "Whitelisted!";
        wlBtn.disabled = true;
        ph.remove();
        tweetEl.style.display = "";
        tweetEl.removeAttribute(PROCESSED_ATTR);
        showToast("Author whitelisted");
      });
    });

    function reveal() {
      tweetEl.style.display = "";
      ph.classList.add("xf-fade-out");
      tweetEl.classList.add("xf-fade-in");
      if (!ph.dataset.revealed) {
        ph.dataset.revealed = "true";
        settings.stats.postsRevealed++;
        saveSettings();
      }
    }
    function conceal() {
      if (!ph.isConnected) return;
      tweetEl.style.display = "none";
      ph.classList.remove("xf-fade-out");
      tweetEl.classList.remove("xf-fade-in");
    }

    ph.addEventListener("mouseenter", reveal);
    ph.addEventListener("mouseleave", conceal);
    cell.addEventListener("mouseleave", conceal);

    cell.insertBefore(ph, tweetEl);
    settings.stats.postsHidden++;
    saveSettings();
  }

  function handleHideSimilar(data) {
    chrome.runtime.sendMessage({
      type: "learnHideSimilar",
      data: { author: data.author, hashtags: data.hashtags, text: data.text.substring(0, 500) }
    });
  }

  function handleWhitelistAuthor(data, onSuccess) {
    if (!data.author) return;
    chrome.runtime.sendMessage({ type: "whitelistAuthor", data: { author: data.author } }, (resp) => {
      if (resp?.success) {
        if (!settings.whitelistedAuthors.includes(data.author)) settings.whitelistedAuthors.push(data.author);
        onSuccess?.();
      }
    });
  }

  function saveSettings() {
    chrome.runtime.sendMessage({
      type: "updateStats",
      data: { postsHidden: settings.stats.postsHidden, postsRevealed: settings.stats.postsRevealed }
    });
  }

  function showToast(msg) {
    document.querySelector(".xf-toast")?.remove();
    const t = document.createElement("div");
    t.className = "xf-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("xf-toast-visible"));
    setTimeout(() => {
      t.classList.remove("xf-toast-visible");
      setTimeout(() => t.remove(), 300);
    }, 2000);
  }

  // --- Floating Status Indicator ---

  function showStatusIndicator() {
    if (document.getElementById("xf-status")) return;
    const el = document.createElement("div");
    el.id = "xf-status";
    el.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 99999;
      background: #1d9bf0; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px; font-weight: 700; padding: 10px 18px;
      border-radius: 24px; cursor: pointer; opacity: 0.92;
      transition: opacity 200ms, transform 100ms; user-select: none;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      display: flex; align-items: center; gap: 8px;
    `;
    el.title = "X Filter is active. Click to force re-scan.";
    el.innerHTML = `
      <span style="font-size:16px">🛡️</span>
      <span>X Filter ON</span>
      <span id="xf-count" style="background:rgba(255,255,255,0.25);padding:2px 8px;border-radius:12px;font-size:11px;min-width:20px;text-align:center">0</span>
    `;
    el.addEventListener("click", () => {
      log("Manual re-scan triggered.");
      reprocessAll();
    });
    el.addEventListener("mouseenter", () => el.style.opacity = "1");
    el.addEventListener("mouseleave", () => el.style.opacity = "0.92");
    document.body.appendChild(el);
  }

  function hideStatusIndicator() {
    document.getElementById("xf-status")?.remove();
  }

  function updateStatusIndicator() {
    const el = document.getElementById("xf-status");
    if (!el) return;
    const tweets = getVisibleTweets();
    const hidden = tweets.filter((t) => t.style.display === "none").length;
    const countEl = el.querySelector("#xf-count");
    if (countEl) countEl.textContent = String(hidden);

    // Also update browser action badge
    chrome.runtime.sendMessage({ type: "updateBadge", count: hidden });
  }

  // --- Utilities ---

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function keywordMatch(text, keyword) {
    const kw = keyword.toLowerCase();
    if (kw.includes(" ")) return text.includes(kw);
    return new RegExp("\\b" + escapeRegex(kw) + "\\b").test(text);
  }

  // --- Keyboard ---

  document.addEventListener("keydown", (e) => {
    if (e.shiftKey && e.key === "H") {
      const tweet = document.activeElement?.closest('article[data-testid="tweet"]');
      if (tweet) {
        const d = extractTweetData(tweet);
        if (d) { handleHideSimilar(d); showToast("Pattern learned"); }
      }
    }
  });

  init();
})();
