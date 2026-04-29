(function () {
  const PROCESSED_ATTR = "data-filter-processed";
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

  // --- Settings Loading with Retry ---

  function init() {
    log("Initializing X Filter content script...");
    tryLoadSettings();
  }

  function tryLoadSettings() {
    initAttempts++;
    log(`Loading settings (attempt ${initAttempts}/${MAX_INIT_ATTEMPTS})...`);

    chrome.runtime.sendMessage({ type: "getSettings" }, (response) => {
      if (chrome.runtime.lastError) {
        warn("Settings load error:", chrome.runtime.lastError.message);
        scheduleRetry();
        return;
      }

      if (response?.settings) {
        settings = response.settings;
        log("Settings loaded. enabled:", settings.enabled, "filters:", JSON.stringify(settings.activeFilters));
        log("Keywords loaded - political:", settings.keywords?.political?.length, "movies:", settings.keywords?.movies?.length, "sensationalism:", settings.keywords?.sensationalism?.length);
        log("Tech whitelist:", settings.techWhitelist?.length, "Learned authors:", settings.learned?.authors?.length);

        if (settings.enabled) {
          startFiltering();
        } else {
          log("Filtering is disabled in settings.");
        }
      } else {
        warn("No settings received from background.");
        scheduleRetry();
      }
    });
  }

  function scheduleRetry() {
    if (initAttempts < MAX_INIT_ATTEMPTS) {
      const delay = Math.min(500 * initAttempts, 3000);
      log(`Retrying settings load in ${delay}ms...`);
      setTimeout(tryLoadSettings, delay);
    } else {
      warn("Failed to load settings after maximum attempts. Filtering will not work.");
    }
  }

  // --- Message Handling ---

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "settingsUpdated") {
      log("Received settingsUpdated message.", message.data);
      settings = message.data;
      if (settings.enabled) {
        reprocessAll();
        startFiltering();
      } else {
        stopFiltering();
      }
      if (sendResponse) sendResponse({ received: true });
    }
    return true;
  });

  // --- DOM Observation ---

  function startFiltering() {
    log("Starting filtering...");
    processVisibleTweets();
    observeDOM();
    startPeriodicScan();
  }

  function observeDOM() {
    if (observer) {
      log("Observer already running.");
      return;
    }

    observer = new MutationObserver((mutations) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        let hasNewTweets = false;
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (
              (node.matches && node.matches('article[data-testid="tweet"]')) ||
              (node.querySelectorAll && node.querySelectorAll('article[data-testid="tweet"]').length > 0)
            ) {
              hasNewTweets = true;
              break;
            }
          }
          if (hasNewTweets) break;
        }
        if (hasNewTweets) {
          log("DOM mutation detected new tweets.");
          processVisibleTweets();
        }
      }, 50);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    log("MutationObserver started on document.body.");
  }

  function stopFiltering() {
    log("Stopping filtering...");
    if (observer) {
      observer.disconnect();
      observer = null;
      log("MutationObserver disconnected.");
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (periodicScanTimer) {
      clearInterval(periodicScanTimer);
      periodicScanTimer = null;
      log("Periodic scan stopped.");
    }
  }

  function startPeriodicScan() {
    if (periodicScanTimer) clearInterval(periodicScanTimer);
    periodicScanTimer = setInterval(() => {
      if (settings && settings.enabled) {
        const tweets = getVisibleTweets();
        const unprocessed = tweets.filter((t) => !t.getAttribute(PROCESSED_ATTR)).length;
        if (unprocessed > 0) {
          log(`Periodic scan: ${unprocessed} unprocessed tweets found.`);
          processVisibleTweets();
        }
      }
    }, 2000);
    log("Periodic scan started (every 2s).");
  }

  // --- Tweet Processing ---

  function getVisibleTweets() {
    return Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  }

  const BATCH_SIZE = 20;

  function processVisibleTweets() {
    const tweets = getVisibleTweets();
    if (tweets.length === 0) {
      log("No tweets found in DOM.");
      return;
    }

    let processed = 0;
    let skipped = 0;
    let hidden = 0;

    for (const tweet of tweets) {
      if (processed >= BATCH_SIZE) {
        setTimeout(() => processVisibleTweets(), 100);
        break;
      }
      if (tweet.getAttribute(PROCESSED_ATTR)) {
        skipped++;
        continue;
      }
      const result = processTweet(tweet);
      if (result) hidden++;
      processed++;
    }

    if (processed > 0 || hidden > 0) {
      log(`Processed ${processed} tweets, hidden ${hidden}, skipped ${skipped} already processed. Total tweets in DOM: ${tweets.length}`);
    }
  }

  function reprocessAll() {
    log("Reprocessing all tweets...");
    const tweets = getVisibleTweets();
    tweets.forEach((tweet) => {
      tweet.removeAttribute(PROCESSED_ATTR);
      tweet.parentElement.querySelectorAll(".xf-placeholder").forEach((placeholder) => placeholder.remove());
      tweet.style.display = "";
    });

    let offset = 0;
    function processBatch() {
      let count = 0;
      for (let i = offset; i < tweets.length; i++) {
        if (count >= BATCH_SIZE) {
          offset = i;
          setTimeout(processBatch, 50);
          return;
        }
        if (!tweets[i].getAttribute(PROCESSED_ATTR)) {
          processTweet(tweets[i]);
          count++;
        }
      }
      log(`Reprocessed ${tweets.length} tweets.`);
    }
    processBatch();
  }

  function processTweet(tweetEl) {
    if (!settings || !settings.enabled) {
      warn("processTweet called but settings not ready or disabled.");
      return false;
    }

    tweetEl.setAttribute(PROCESSED_ATTR, "true");

    const tweetData = extractTweetData(tweetEl);
    if (!tweetData) {
      warn("Failed to extract tweet data.");
      return false;
    }

    const result = scoreTweet(tweetData);

    if (result.hidden) {
      hideTweet(tweetEl, result.reason, tweetData);
      log(`HIDDEN [${result.reason}] author=${tweetData.author || "(none)"} text="${tweetData.text.substring(0, 60)}..."`);
      return true;
    } else {
      log(`VISIBLE author=${tweetData.author || "(none)"} text="${tweetData.text.substring(0, 60)}..."`);
      return false;
    }
  }

  // --- Data Extraction ---

  function extractTweetData(tweetEl) {
    const cellInnerDiv = tweetEl.closest('div[data-testid="cellInnerDiv"]') || tweetEl.parentElement;
    if (!cellInnerDiv) {
      warn("No cell element found for tweet.");
      return null;
    }

    // Primary: data-testid="tweetText" for tweet text
    const textEl = tweetEl.querySelector('[data-testid="tweetText"]');
    const text = textEl ? (textEl.textContent || "") : "";

    // Author extraction: try profile links first
    let authorHandle = "";
    const allLinks = tweetEl.querySelectorAll("a[href]");
    const EXCLUDED_PATHS = new Set([
      "home", "explore", "notifications", "messages", "i", "search",
      "settings", "compose", "login", "logout", "signup", "intent",
      "share", "hashtag"
    ]);

    for (const link of allLinks) {
      const href = link.getAttribute("href") || "";
      const parts = href.split("/").filter(Boolean);
      // X.com profile links are /username (single path segment)
      if (parts.length === 1 && !EXCLUDED_PATHS.has(parts[0].toLowerCase())) {
        // Extra validation: usernames are 1-15 chars, alphanumeric + underscore
        const handle = parts[0];
        if (/^[a-zA-Z0-9_]{1,15}$/.test(handle)) {
          authorHandle = handle;
          break;
        }
      }
    }

    // Fallback: avatar image alt text
    if (!authorHandle) {
      const avatarEl = tweetEl.querySelector('img[alt^="@"]');
      if (avatarEl) {
        const alt = avatarEl.getAttribute("alt") || "";
        if (alt.startsWith("@")) {
          authorHandle = alt.substring(1);
        }
      }
    }

    // Fallback: any element with text that looks like @username inside the tweet
    if (!authorHandle) {
      const handleEl = tweetEl.querySelector('a[role="link"]');
      if (handleEl) {
        const text = handleEl.textContent || "";
        if (text.startsWith("@")) {
          authorHandle = text.substring(1);
        }
      }
    }

    const hashtags = [];
    const hashtagEls = tweetEl.querySelectorAll('a[href*="/hashtag/"]');
    hashtagEls.forEach((el) => {
      const tag = el.textContent.trim();
      if (tag) hashtags.push(tag);
    });

    const data = {
      text,
      author: authorHandle ? "@" + authorHandle : "",
      hashtags,
      element: tweetEl,
      cellElement: cellInnerDiv
    };

    return data;
  }

  // --- Scoring ---

  function scoreTweet(tweetData) {
    const { text, author, hashtags } = tweetData;
    const lowerText = text.toLowerCase();

    // Whitelisted authors always show
    if (author && settings.whitelistedAuthors?.includes(author)) {
      return { hidden: false, reason: "" };
    }

    // Tech protection override
    if (Array.isArray(settings.techWhitelist)) {
      for (const term of settings.techWhitelist) {
        if (term.includes(" ")) {
          if (lowerText.includes(term.toLowerCase())) {
            return { hidden: false, reason: "" };
          }
        } else if (new RegExp("\\b" + escapeRegex(term.toLowerCase()) + "\\b").test(lowerText)) {
          return { hidden: false, reason: "" };
        }
      }
    }

    let score = 0;
    let reason = "";

    // Active filter scoring
    if (settings.activeFilters?.political && Array.isArray(settings.keywords?.political)) {
      for (const kw of settings.keywords.political) {
        if (keywordMatch(lowerText, kw)) {
          score += 2;
          if (!reason) reason = "Political content";
        }
      }
    }

    if (settings.activeFilters?.movies && Array.isArray(settings.keywords?.movies)) {
      for (const kw of settings.keywords.movies) {
        if (keywordMatch(lowerText, kw)) {
          score += 2;
          if (!reason) reason = "Movies & Gossip";
        }
      }
    }

    if (settings.activeFilters?.sensationalism && Array.isArray(settings.keywords?.sensationalism)) {
      for (const kw of settings.keywords.sensationalism) {
        if (keywordMatch(lowerText, kw)) {
          score += 1;
          if (!reason && score >= 3) reason = "Sensationalism";
        }
      }
    }

    // Learned patterns (always active)
    if (Array.isArray(settings.learned?.authors) && settings.learned.authors.includes(author)) {
      score += 3;
      if (!reason) reason = "Learned author";
    }

    if (Array.isArray(settings.learned?.hashtags)) {
      for (const tag of hashtags) {
        if (settings.learned.hashtags.includes(tag)) {
          score += 2;
          if (!reason) reason = "Learned hashtag";
        }
      }
    }

    if (Array.isArray(settings.learned?.keywords)) {
      for (const kw of settings.learned.keywords) {
        if (keywordMatch(lowerText, kw)) {
          score += 1;
        }
      }
    }

    return {
      hidden: score >= 3,
      reason: reason || "Filtered content",
      score
    };
  }

  // --- Placeholder UI ---

  function hideTweet(tweetEl, reason, tweetData) {
    const cell = tweetData.cellElement;
    if (!cell) {
      warn("Cannot hide tweet: no cell element.");
      return;
    }

    // Remove any existing placeholder for this tweet
    cell.querySelectorAll(".xf-placeholder").forEach((p) => p.remove());

    tweetEl.style.display = "none";

    const placeholder = document.createElement("div");
    placeholder.className = "xf-placeholder";
    placeholder.innerHTML = `
      <div class="xf-placeholder-inner">
        <div class="xf-icon-row">
          <span class="xf-filter-icon">&#x26A0;</span>
          <span class="xf-reason">${escapeHtml(reason)}</span>
        </div>
        <div class="xf-hint">Hover to reveal</div>
        <div class="xf-actions">
          <button class="xf-btn xf-btn-hide" title="Hide similar posts from this author/topic">Hide similar</button>
          <button class="xf-btn xf-btn-whitelist" title="Always show posts from ${escapeHtml(tweetData.author || "this author")}">&#x2714; Always show ${escapeHtml(tweetData.author || "@author")}</button>
        </div>
      </div>
    `;

    const hideBtn = placeholder.querySelector(".xf-btn-hide");
    const whitelistBtn = placeholder.querySelector(".xf-btn-whitelist");

    if (!tweetData.author) {
      whitelistBtn.disabled = true;
      whitelistBtn.textContent = "Author unavailable";
    }

    hideBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleHideSimilar(tweetData);
      hideBtn.textContent = "Learned!";
      hideBtn.disabled = true;
      showToast("Pattern learned — similar posts will be hidden");
    });

    whitelistBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!tweetData.author) return;
      handleWhitelistAuthor(tweetData, () => {
        whitelistBtn.textContent = "Whitelisted!";
        whitelistBtn.disabled = true;
        placeholder.remove();
        tweetEl.style.display = "";
        tweetEl.removeAttribute(PROCESSED_ATTR);
        showToast("Author whitelisted — posts will always show");
      });
    });

    function revealTweet() {
      tweetEl.style.display = "";
      placeholder.classList.add("xf-fade-out");
      tweetEl.classList.add("xf-fade-in");
      if (!placeholder.dataset.revealed) {
        placeholder.dataset.revealed = "true";
        settings.stats.postsRevealed++;
        saveSettings();
      }
    }

    function concealTweet() {
      if (!placeholder.isConnected) return;
      tweetEl.style.display = "none";
      placeholder.classList.remove("xf-fade-out");
      tweetEl.classList.remove("xf-fade-in");
    }

    placeholder.addEventListener("mouseenter", revealTweet);
    placeholder.addEventListener("mouseleave", concealTweet);
    cell.addEventListener("mouseleave", concealTweet);

    cell.insertBefore(placeholder, tweetEl);
    settings.stats.postsHidden++;
    saveSettings();
  }

  function handleHideSimilar(tweetData) {
    chrome.runtime.sendMessage({
      type: "learnHideSimilar",
      data: {
        author: tweetData.author,
        hashtags: tweetData.hashtags,
        text: tweetData.text.substring(0, 500)
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        warn("learnHideSimilar error:", chrome.runtime.lastError.message);
      }
    });
  }

  function handleWhitelistAuthor(tweetData, onSuccess) {
    if (!tweetData.author) return;
    chrome.runtime.sendMessage({
      type: "whitelistAuthor",
      data: { author: tweetData.author }
    }, (response) => {
      if (chrome.runtime.lastError) {
        warn("whitelistAuthor error:", chrome.runtime.lastError.message);
        return;
      }
      if (response?.success) {
        if (!settings.whitelistedAuthors.includes(tweetData.author)) {
          settings.whitelistedAuthors.push(tweetData.author);
        }
        onSuccess?.();
      }
    });
  }

  function saveSettings() {
    chrome.runtime.sendMessage({
      type: "updateStats",
      data: {
        postsHidden: settings.stats.postsHidden,
        postsRevealed: settings.stats.postsRevealed
      }
    }, () => {
      if (chrome.runtime.lastError) {
        warn("saveStats error:", chrome.runtime.lastError.message);
      }
    });
  }

  function showToast(message) {
    const existing = document.querySelector(".xf-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "xf-toast";
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("xf-toast-visible"));
    setTimeout(() => {
      toast.classList.remove("xf-toast-visible");
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function keywordMatch(text, keyword) {
    const kw = keyword.toLowerCase();
    if (kw.includes(" ")) {
      return text.includes(kw);
    }
    return new RegExp("\\b" + escapeRegex(kw) + "\\b").test(text);
  }

  // --- Keyboard Shortcut ---

  document.addEventListener("keydown", (e) => {
    if (e.shiftKey && e.key === "H") {
      const focused = document.activeElement;
      const tweet = focused?.closest('article[data-testid="tweet"]');
      if (tweet) {
        const tweetData = extractTweetData(tweet);
        if (tweetData) {
          handleHideSimilar(tweetData);
          showToast("Pattern learned — similar posts will be hidden");
        }
      }
    }
  });

  init();
})();
