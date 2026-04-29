(function () {
  const PROCESSED_ATTR = "data-filter-processed";
  let settings = null;
  let debounceTimer = null;

  function init() {
    chrome.runtime.sendMessage({ type: "getSettings" }, (response) => {
      settings = response?.settings || null;
      if (settings && settings.enabled) {
        startFiltering();
      }
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "settingsUpdated") {
      settings = message.data;
      if (settings.enabled) {
        reprocessAll();
        startFiltering();
      } else {
        restoreAllHidden();
      }
    }
  });

  function startFiltering() {
    processVisibleTweets();
    observeDOM();
  }

  function observeDOM() {
    const observer = new MutationObserver((mutations) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        let hasNewNodes = false;
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (
              (node.matches && node.matches('article[data-testid="tweet"]')) ||
              (node.querySelectorAll && node.querySelectorAll('article[data-testid="tweet"]').length > 0)
            ) {
              hasNewNodes = true;
              break;
            }
          }
          if (hasNewNodes) break;
        }
        if (hasNewNodes) {
          processVisibleTweets();
        }
      }, 50);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function getVisibleTweets() {
    return Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  }

  const BATCH_SIZE = 20;

  function processVisibleTweets() {
    const tweets = getVisibleTweets();
    let processed = 0;
    for (const tweet of tweets) {
      if (processed >= BATCH_SIZE) {
        setTimeout(() => processVisibleTweets(), 100);
        break;
      }
      if (tweet.getAttribute(PROCESSED_ATTR)) continue;
      processTweet(tweet);
      processed++;
    }
  }

  function reprocessAll() {
    const tweets = getVisibleTweets();
    tweets.forEach((tweet) => {
      tweet.removeAttribute(PROCESSED_ATTR);
      const placeholder = tweet.parentElement.querySelector(".xf-placeholder");
      if (placeholder) {
        placeholder.remove();
        tweet.style.display = "";
      }
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
    }
    processBatch();
  }

  function restoreAllHidden() {
    const tweets = getVisibleTweets();
    tweets.forEach((tweet) => {
      tweet.removeAttribute(PROCESSED_ATTR);
      const placeholder = tweet.parentElement.querySelector(".xf-placeholder");
      if (placeholder) {
        placeholder.remove();
        tweet.style.display = "";
      }
    });
  }

  function processTweet(tweetEl) {
    if (!settings || !settings.enabled) return;
    tweetEl.setAttribute(PROCESSED_ATTR, "true");

    const tweetData = extractTweetData(tweetEl);
    if (!tweetData) return;

    const result = scoreTweet(tweetData);

    if (result.hidden) {
      hideTweet(tweetEl, result.reason, tweetData);
    }
  }

  function extractTweetData(tweetEl) {
    const cellInnerDiv = tweetEl.closest('div[data-testid="cellInnerDiv"]') || tweetEl.parentElement;
    if (!cellInnerDiv) return null;

    const textEl = tweetEl.querySelector('[data-testid="tweetText"]') ||
                   tweetEl.querySelector('[lang]');

    let authorHandle = "";
    const userLink = tweetEl.querySelector('a[href*="/"] [role="link"]');
    const allLinks = tweetEl.querySelectorAll("a[href]");
    for (const link of allLinks) {
      const href = link.getAttribute("href") || "";
      if (href.startsWith("/") && href.split("/").length === 2) {
        authorHandle = href.substring(1);
        break;
      }
    }

    const avatarEl = tweetEl.querySelector('img[alt][draggable="true"]');
    if (!authorHandle && avatarEl) {
      const alt = avatarEl.getAttribute("alt") || "";
      if (alt.startsWith("@")) {
        authorHandle = alt.substring(1);
      }
    }

    const text = textEl ? textEl.textContent || "" : "";

    const hashtags = [];
    const hashtagEls = tweetEl.querySelectorAll('a[href*="/hashtag/"]');
    hashtagEls.forEach((el) => {
      const tag = el.textContent.trim();
      if (tag) hashtags.push(tag);
    });

    return {
      text,
      author: authorHandle ? "@" + authorHandle : "",
      hashtags,
      element: tweetEl,
      cellElement: cellInnerDiv
    };
  }

  function scoreTweet(tweetData) {
    const { text, author, hashtags } = tweetData;
    const lowerText = text.toLowerCase();

    if (author && settings.whitelistedAuthors.includes(author)) {
      return { hidden: false, reason: "" };
    }

    for (const term of settings.techWhitelist) {
      if (term.includes(" ")) {
        if (lowerText.includes(term.toLowerCase())) {
          return { hidden: false, reason: "" };
        }
      } else if (new RegExp("\\b" + escapeRegex(term.toLowerCase()) + "\\b").test(lowerText)) {
        return { hidden: false, reason: "" };
      }
    }

    let score = 0;
    let reason = "";

    if (settings.activeFilters.political) {
      for (const kw of settings.keywords.political) {
        if (keywordMatch(lowerText, kw)) {
          score += 2;
          if (!reason) reason = "Political content";
        }
      }
    }

    if (settings.activeFilters.movies) {
      for (const kw of settings.keywords.movies) {
        if (keywordMatch(lowerText, kw)) {
          score += 2;
          if (!reason) reason = "Movies & Gossip";
        }
      }
    }

    if (settings.activeFilters.sensationalism) {
      for (const kw of settings.keywords.sensationalism) {
        if (keywordMatch(lowerText, kw)) {
          score += 1;
          if (!reason && score >= 3) reason = "Sensationalism";
        }
      }
    }

    if (settings.activeFilters.intlRelations) {
      for (const kw of settings.keywords.intlRelations) {
        if (keywordMatch(lowerText, kw)) {
          score += 2;
          if (!reason) reason = "International Relations";
        }
      }
    }

    if (settings.learned.authors.includes(author)) {
      score += 3;
      if (!reason) reason = "Learned author";
    }

    for (const tag of hashtags) {
      if (settings.learned.hashtags.includes(tag)) {
        score += 2;
        if (!reason) reason = "Learned hashtag";
      }
    }

    for (const kw of settings.learned.keywords) {
      if (keywordMatch(lowerText, kw)) {
        score += 1;
      }
    }

    return {
      hidden: score >= 3,
      reason: reason || "Filtered content"
    };
  }

  function hideTweet(tweetEl, reason, tweetData) {
    const cell = tweetData.cellElement;
    if (!cell) return;

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
          <button class="xf-btn xf-btn-whitelist" title="Always show posts from @${escapeHtml(tweetData.author.replace("@", ""))}">&#x2714; Always show ${escapeHtml(tweetData.author)}</button>
        </div>
      </div>
    `;

    const hideBtn = placeholder.querySelector(".xf-btn-hide");
    const whitelistBtn = placeholder.querySelector(".xf-btn-whitelist");

    hideBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleHideSimilar(tweetData);
      hideBtn.textContent = "Learned!";
      hideBtn.disabled = true;
      showToast("Pattern learned — similar posts will be hidden");
    });

    whitelistBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleWhitelistAuthor(tweetData);
      whitelistBtn.textContent = "Whitelisted!";
      whitelistBtn.disabled = true;
      showToast("Author whitelisted — posts will always show");
    });

    placeholder.addEventListener("mouseenter", () => {
      tweetEl.style.display = "";
      placeholder.classList.add("xf-fade-out");
      tweetEl.classList.add("xf-fade-in");
      if (!placeholder.dataset.revealed) {
        placeholder.dataset.revealed = "true";
        settings.stats.postsRevealed++;
        saveSettings();
      }
    });

    placeholder.addEventListener("mouseleave", () => {
      tweetEl.style.display = "none";
      placeholder.classList.remove("xf-fade-out");
      tweetEl.classList.remove("xf-fade-in");
    });

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
    });
  }

  function handleWhitelistAuthor(tweetData) {
    chrome.runtime.sendMessage({
      type: "whitelistAuthor",
      data: { author: tweetData.author }
    });
  }

  function saveSettings() {
    chrome.runtime.sendMessage({ type: "updateStats", data: { postsHidden: settings.stats.postsHidden, postsRevealed: settings.stats.postsRevealed } });
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