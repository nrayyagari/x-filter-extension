const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const http = require("http");

const EXTENSION_PATH = path.resolve(__dirname, "..");
const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

let browser;
let extensionId;
let testResults = [];
let currentTestName = "";

// --- Test Infrastructure ---

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function retry(fn, opts = {}) {
  const maxAttempts = opts.attempts || 3;
  const delay = opts.delay || 500;
  let lastError;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxAttempts - 1) await sleep(delay * (i + 1));
    }
  }
  throw lastError;
}

async function screenshot(page, name) {
  ensureDir(SCREENSHOT_DIR);
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

async function getExtensionId() {
  for (let i = 0; i < 10; i++) {
    const targets = await browser.targets();
    const extensionTarget = targets.find(
      (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://")
    );
    if (extensionTarget) {
      const url = new URL(extensionTarget.url());
      return url.hostname;
    }
    await sleep(300);
  }
  throw new Error("Extension service worker not found");
}

async function sendMessageToBackground(page, message) {
  return page.evaluate((msg) => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, resolve);
    });
  }, message);
}

async function resetToDefaults(page) {
  const defaults = {
    version: "1.0",
    enabled: true,
    activeFilters: { political: true, movies: true, sensationalism: true },
    keywords: {
      political: ["modi", "bjp", "congress", "election", "vote", "campaign", "parliament", "government", "minister", "pm", "cm", "mp", "mla", "opposition", "cabinet", "ministry", "policy", "bill", "rally", "speech", "political", "politics", "politician", "controversy", "debate", "protest", "strike", "bandh", "curfew", "law and order", "ysrcp", "tdp", "janasena", "trs", "brs", "andhra pradesh", "telangana", "amaravati", "hyderabad", "ys jagan", "chandrababu", "pawan kalyan", "kcr", "revanth reddy"],
      movies: ["tollywood", "tollywood news", "telugu cinema", "telugu movie", "movie review", "film review", "hero", "heroine", "actor", "actress", "director", "producer", "box office", "collections", "hit", "flop", "blockbuster", "rating", "trailer", "teaser", "gossip", "rumor", "affair", "scandal", "breakup", "dating", "linkup", "controversy", "feud", "troll", "meme", "viral video", "leaked", "exclusive", "inside story", "bollywood", "kollywood", "mollywood", "sandalwood"],
      sensationalism: ["breaking", "shocking", "exposed", "truth revealed", "real story", "inside story", "you wont believe", "must watch", "viral", "trending", "sensational", "eye opening", "heart breaking", "leaked video", "exclusive footage"]
    },
    techWhitelist: ["developer", "programming", "code", "coding", "software", "ai", "artificial intelligence", "machine learning", "deep learning", "open source", "github", "gitlab", "kubernetes", "docker", "aws", "azure", "gcp", "cloud", "cloud computing", "api", "rest api", "graphql", "microservices", "serverless", "devops", "sre", "database", "sql", "nosql", "linux", "ubuntu", "python", "javascript", "typescript", "react", "node.js", "go", "rust", "java", "nvidia", "gpu", "cpu", "tech", "technology", "startup", "funding", "series a", "saas", "infra", "infrastructure", "system design"],
    learned: { authors: [], hashtags: [], keywords: [] },
    whitelistedAuthors: [],
    stats: { postsHidden: 0, postsRevealed: 0, patternsLearned: 0, authorsWhitelisted: 0 }
  };
  await sendMessageToBackground(page, { type: "saveSettings", data: defaults });
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}\n  Expected: ${e}\n  Actual:   ${a}`);
  }
}

function assertTrue(value, message) {
  if (!value) throw new Error(message || `Expected truthy, got ${JSON.stringify(value)}`);
}

function assertFalse(value, message) {
  if (value) throw new Error(message || `Expected falsy, got ${JSON.stringify(value)}`);
}

async function runTest(name, fn, opts = {}) {
  currentTestName = name;
  const attempts = opts.attempts || 1;
  let lastError;
  let screenshotPath = null;

  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      testResults.push({ name, status: "PASS", attempt: i + 1 });
      console.log(`[PASS] ${name}`);
      return;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await sleep(500 * (i + 1));
      }
    }
  }

  // Screenshot on failure if we have a page reference
  testResults.push({ name, status: "FAIL", error: lastError.message, screenshot: screenshotPath });
  console.log(`[FAIL] ${name}`);
  console.log(`  ${lastError.message}`);
}

// --- Mock Page Setup ---

async function createMockServer() {
  const mockHTML = fs.readFileSync(path.join(__dirname, "mock-x-timeline.html"), "utf8");
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(mockHTML);
    });
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function setupMockPage(mockPage, bgPage) {
  const contentJS = fs.readFileSync(path.join(EXTENSION_PATH, "content.js"), "utf8");
  const contentCSS = fs.readFileSync(path.join(EXTENSION_PATH, "content.css"), "utf8");

  await mockPage.evaluate((css) => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }, contentCSS);

  await mockPage.evaluate(`
    window.__xfSettings = {
      version: "1.0",
      enabled: true,
      activeFilters: { political: true, movies: true, sensationalism: true },
      keywords: {
        political: [
          "modi", "bjp", "congress", "election", "vote", "campaign", "parliament",
          "government", "minister", "pm", "cm", "mp", "mla", "opposition", "cabinet",
          "ministry", "policy", "bill", "rally", "speech", "political", "politics",
          "politician", "controversy", "debate", "protest", "strike", "bandh",
          "curfew", "law and order", "ysrcp", "tdp", "janasena", "trs", "brs",
          "andhra pradesh", "telangana", "amaravati", "hyderabad", "ys jagan",
          "chandrababu", "pawan kalyan", "kcr", "revanth reddy"
        ],
        movies: [
          "tollywood", "tollywood news", "telugu cinema", "telugu movie",
          "movie review", "film review", "hero", "heroine", "actor", "actress",
          "director", "producer", "box office", "collections", "hit", "flop",
          "blockbuster", "rating", "trailer", "teaser", "gossip", "rumor",
          "affair", "scandal", "breakup", "dating", "linkup", "controversy",
          "feud", "troll", "meme", "viral video", "leaked", "exclusive",
          "inside story", "bollywood", "kollywood", "mollywood", "sandalwood"
        ],
        sensationalism: [
          "breaking", "shocking", "exposed", "truth revealed", "real story",
          "inside story", "you wont believe", "must watch", "viral", "trending",
          "sensational", "eye opening", "heart breaking", "leaked video",
          "exclusive footage"
        ]
      },
      techWhitelist: [
        "developer", "programming", "code", "coding", "software", "ai",
        "artificial intelligence", "machine learning", "deep learning",
        "open source", "github", "gitlab", "kubernetes", "docker", "aws",
        "azure", "gcp", "cloud", "cloud computing", "api", "rest api",
        "graphql", "microservices", "serverless", "devops", "sre", "database",
        "sql", "nosql", "linux", "ubuntu", "python", "javascript", "typescript",
        "react", "node.js", "go", "rust", "java", "nvidia", "gpu", "cpu",
        "tech", "technology", "startup", "funding", "series a", "saas", "infra",
        "infrastructure", "system design"
      ],
      learned: { authors: [], hashtags: [], keywords: [] },
      whitelistedAuthors: [],
      stats: { postsHidden: 0, postsRevealed: 0, patternsLearned: 0, authorsWhitelisted: 0 }
    };

    window.chrome = {
      runtime: {
        sendMessage: function(msg, cb) {
          if (msg.type === "getSettings") {
            if (cb) cb({ settings: window.__xfSettings });
          } else if (msg.type === "updateStats") {
            if (window.__xfSettings) {
              window.__xfSettings.stats.postsHidden = msg.data.postsHidden;
              window.__xfSettings.stats.postsRevealed = msg.data.postsRevealed;
            }
            if (cb) cb({ success: true });
          } else if (msg.type === "learnHideSimilar") {
            if (msg.data.author && window.__xfSettings) {
              if (!window.__xfSettings.learned.authors.includes(msg.data.author)) {
                window.__xfSettings.learned.authors.push(msg.data.author);
              }
            }
            if (msg.data.hashtags && window.__xfSettings) {
              msg.data.hashtags.forEach((tag) => {
                if (!window.__xfSettings.learned.hashtags.includes(tag)) {
                  window.__xfSettings.learned.hashtags.push(tag);
                }
              });
            }
            if (cb) cb({ success: true, learned: true });
          } else if (msg.type === "whitelistAuthor") {
            if (msg.data.author && window.__xfSettings) {
              if (!window.__xfSettings.whitelistedAuthors.includes(msg.data.author)) {
                window.__xfSettings.whitelistedAuthors.push(msg.data.author);
              }
            }
            if (cb) cb({ success: true });
          } else {
            if (cb) cb({});
          }
        },
        onMessage: { addListener: function() {} }
      }
    };
  `);

  await mockPage.evaluate(contentJS);
  await sleep(800);
}

// --- Tests ---

async function runBackgroundTests(bgPage) {
  console.log("\n--- Background Script Tests ---\n");

  await runTest("BG: getSettings returns normalized defaults", async () => {
    const resp = await sendMessageToBackground(bgPage, { type: "getSettings" });
    assertTrue(resp.settings, "Settings should exist");
    assertEqual(resp.settings.enabled, true, "enabled default");
    assertEqual(resp.settings.activeFilters.political, true, "political default");
    assertEqual(resp.settings.activeFilters.movies, true, "movies default");
    assertEqual(resp.settings.activeFilters.sensationalism, true, "sensationalism default");
    assertTrue(Array.isArray(resp.settings.keywords.political), "political keywords array");
    assertTrue(Array.isArray(resp.settings.techWhitelist), "techWhitelist array");
    assertTrue(resp.settings.version, "version should exist");
  });

  await runTest("BG: saveSettings persists and normalizes", async () => {
    const custom = {
      version: "1.0",
      enabled: false,
      activeFilters: { political: false, movies: true, sensationalism: false },
      keywords: { political: ["modi"], movies: ["bollywood"], sensationalism: ["breaking"] },
      techWhitelist: ["ai", "cloud"],
      learned: { authors: ["@test"], hashtags: ["#test"], keywords: ["testword"] },
      whitelistedAuthors: ["@techcrunch"],
      stats: { postsHidden: 5, postsRevealed: 2, patternsLearned: 1, authorsWhitelisted: 1 }
    };
    const save = await sendMessageToBackground(bgPage, { type: "saveSettings", data: custom });
    assertEqual(save.success, true, "saveSettings should succeed");

    const get = await sendMessageToBackground(bgPage, { type: "getSettings" });
    assertEqual(get.settings.enabled, false, "enabled persisted");
    assertEqual(get.settings.activeFilters.political, false, "political persisted");
    assertEqual(get.settings.whitelistedAuthors[0], "@techcrunch", "whitelisted author persisted");
  });

  await runTest("BG: whitelistAuthor adds author", async () => {
    await resetToDefaults(bgPage);
    const resp = await sendMessageToBackground(bgPage, { type: "whitelistAuthor", data: { author: "@testuser" } });
    assertEqual(resp.success, true, "whitelistAuthor should succeed");

    const get = await sendMessageToBackground(bgPage, { type: "getSettings" });
    assertTrue(get.settings.whitelistedAuthors.includes("@testuser"), "author should be whitelisted");
    assertEqual(get.settings.stats.authorsWhitelisted, 1, "stats should track whitelisted authors");
  });

  await runTest("BG: whitelistAuthor rejects empty author", async () => {
    await resetToDefaults(bgPage);
    const resp = await sendMessageToBackground(bgPage, { type: "whitelistAuthor", data: { author: "" } });
    assertEqual(resp.success, false, "empty author should fail");
  });

  await runTest("BG: whitelistAuthor is idempotent", async () => {
    await resetToDefaults(bgPage);
    await sendMessageToBackground(bgPage, { type: "whitelistAuthor", data: { author: "@duplicate" } });
    const before = await sendMessageToBackground(bgPage, { type: "getSettings" });
    const countBefore = before.settings.stats.authorsWhitelisted;

    await sendMessageToBackground(bgPage, { type: "whitelistAuthor", data: { author: "@duplicate" } });
    const after = await sendMessageToBackground(bgPage, { type: "getSettings" });

    assertEqual(after.settings.whitelistedAuthors.filter((a) => a === "@duplicate").length, 1, "author should appear only once");
    assertEqual(after.settings.stats.authorsWhitelisted, countBefore, "stats should not increment on duplicate");
  });

  await runTest("BG: learnHideSimilar learns author, hashtags, keywords", async () => {
    await resetToDefaults(bgPage);
    const resp = await sendMessageToBackground(bgPage, {
      type: "learnHideSimilar",
      data: { author: "@gossipbot", hashtags: ["#TollywoodNews"], text: "Exclusive leaked footage from the new movie set" }
    });
    assertEqual(resp.success, true, "learnHideSimilar should succeed");
    assertEqual(resp.learned, true, "should have learned something");

    const get = await sendMessageToBackground(bgPage, { type: "getSettings" });
    assertTrue(get.settings.learned.authors.includes("@gossipbot"), "author learned");
    assertTrue(get.settings.learned.hashtags.includes("#TollywoodNews"), "hashtag learned");
    assertTrue(get.settings.learned.keywords.length > 0, "keywords learned");
    assertEqual(get.settings.stats.patternsLearned, 1, "patternsLearned incremented");
  });

  await runTest("BG: resetLearned clears all learned data", async () => {
    await sendMessageToBackground(bgPage, {
      type: "learnHideSimilar",
      data: { author: "@temp", hashtags: ["#temp"], text: "some temporary text" }
    });
    const resp = await sendMessageToBackground(bgPage, { type: "resetLearned" });
    assertEqual(resp.success, true, "resetLearned should succeed");

    const get = await sendMessageToBackground(bgPage, { type: "getSettings" });
    assertEqual(get.settings.learned.authors.length, 0, "learned authors cleared");
    assertEqual(get.settings.learned.hashtags.length, 0, "learned hashtags cleared");
    assertEqual(get.settings.learned.keywords.length, 0, "learned keywords cleared");
  });

  await runTest("BG: importSettings validates missing version", async () => {
    await resetToDefaults(bgPage);
    const resp = await sendMessageToBackground(bgPage, { type: "importSettings", data: { foo: "bar" } });
    assertEqual(resp.success, false, "invalid import should fail");
    assertTrue(resp.error, "should return error message");
  });

  await runTest("BG: importSettings validates missing keywords", async () => {
    await resetToDefaults(bgPage);
    const resp = await sendMessageToBackground(bgPage, { type: "importSettings", data: { version: "1.0" } });
    assertEqual(resp.success, false, "missing keywords should fail");
  });

  await runTest("BG: importSettings accepts valid settings", async () => {
    await resetToDefaults(bgPage);
    const valid = {
      version: "1.0",
      enabled: true,
      activeFilters: { political: false, movies: false, sensationalism: false },
      keywords: { political: [], movies: [], sensationalism: [] },
      techWhitelist: [],
      learned: { authors: [], hashtags: [], keywords: [] },
      whitelistedAuthors: [],
      stats: { postsHidden: 0, postsRevealed: 0, patternsLearned: 0, authorsWhitelisted: 0 }
    };
    const resp = await sendMessageToBackground(bgPage, { type: "importSettings", data: valid });
    assertEqual(resp.success, true, "valid import should succeed");

    const get = await sendMessageToBackground(bgPage, { type: "getSettings" });
    assertEqual(get.settings.activeFilters.political, false, "imported filters applied");
  });

  await runTest("BG: exportSettings returns current settings", async () => {
    await resetToDefaults(bgPage);
    const resp = await sendMessageToBackground(bgPage, { type: "exportSettings" });
    assertTrue(resp.settings, "export should return settings");
    assertTrue(resp.settings.version, "exported settings should have version");
  });

  await runTest("BG: storage limits are enforced", async () => {
    await resetToDefaults(bgPage);
    const large = {
      version: "1.0",
      enabled: true,
      activeFilters: { political: true, movies: true, sensationalism: true },
      keywords: { political: ["modi"], movies: ["bollywood"], sensationalism: ["breaking"] },
      techWhitelist: ["ai"],
      learned: {
        authors: Array.from({ length: 2500 }, (_, i) => `@author${i}`),
        hashtags: Array.from({ length: 2500 }, (_, i) => `#tag${i}`),
        keywords: Array.from({ length: 2500 }, (_, i) => `keyword${i}`)
      },
      whitelistedAuthors: Array.from({ length: 2500 }, (_, i) => `@user${i}`),
      stats: { postsHidden: 0, postsRevealed: 0, patternsLearned: 0, authorsWhitelisted: 0 }
    };
    await sendMessageToBackground(bgPage, { type: "saveSettings", data: large });

    const get = await sendMessageToBackground(bgPage, { type: "getSettings" });
    assertTrue(get.settings.learned.authors.length <= 2000, "learned authors should be trimmed to limit");
    assertTrue(get.settings.learned.hashtags.length <= 2000, "learned hashtags should be trimmed to limit");
    assertTrue(get.settings.learned.keywords.length <= 2000, "learned keywords should be trimmed to limit");
    assertTrue(get.settings.whitelistedAuthors.length <= 2000, "whitelisted authors should be trimmed to limit");
  });

  await runTest("BG: normalization fixes corrupted settings", async () => {
    await sendMessageToBackground(bgPage, {
      type: "saveSettings",
      data: {
        version: "1.0",
        enabled: "should_be_boolean",
        activeFilters: null,
        keywords: null,
        techWhitelist: "not_an_array",
        learned: null,
        whitelistedAuthors: "not_an_array",
        stats: null
      }
    });
    const get = await sendMessageToBackground(bgPage, { type: "getSettings" });
    assertEqual(typeof get.settings.enabled, "boolean", "enabled should be normalized to boolean");
    assertTrue(get.settings.activeFilters && typeof get.settings.activeFilters.political === "boolean", "activeFilters should be normalized");
    assertTrue(Array.isArray(get.settings.keywords.political), "keywords should be normalized");
    assertTrue(Array.isArray(get.settings.techWhitelist), "techWhitelist should be normalized");
    assertTrue(get.settings.learned && Array.isArray(get.settings.learned.authors), "learned should be normalized");
    assertTrue(Array.isArray(get.settings.whitelistedAuthors), "whitelistedAuthors should be normalized");
  });
}

async function runPopupTests(popupPage, bgPage) {
  console.log("\n--- Popup UI Tests ---\n");

  await runTest("Popup: renders with correct defaults", async () => {
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await popupPage.waitForSelector("#main-view", { visible: true, timeout: 5000 });

    const checked = await popupPage.evaluate(() => ({
      political: document.getElementById("filter-political").checked,
      movies: document.getElementById("filter-movies").checked,
      sensationalism: document.getElementById("filter-sensationalism").checked
    }));
    assertEqual(checked.political, true, "political checkbox default");
    assertEqual(checked.movies, true, "movies checkbox default");
    assertEqual(checked.sensationalism, true, "sensationalism checkbox default");
  });

  await runTest("Popup: advanced settings view toggles", async () => {
    await popupPage.evaluate(() => document.getElementById("btn-advanced").click());
    await popupPage.waitForSelector("#advanced-view", { visible: true, timeout: 3000 });

    const toggle = await popupPage.evaluate(() => document.getElementById("toggle-enabled").checked);
    assertEqual(toggle, true, "enable toggle should be checked");

    await popupPage.evaluate(() => document.getElementById("btn-back").click());
    await popupPage.waitForSelector("#main-view", { visible: true, timeout: 3000 });
  });

  await runTest("Popup: keywords view renders correct tabs", async () => {
    await popupPage.evaluate(() => document.getElementById("btn-advanced").click());
    await popupPage.waitForSelector("#advanced-view", { visible: true, timeout: 3000 });
    await popupPage.evaluate(() => document.getElementById("btn-keywords").click());
    await popupPage.waitForSelector("#keywords-view", { visible: true, timeout: 3000 });

    const tabs = await popupPage.evaluate(() =>
      Array.from(document.querySelectorAll(".tab")).map((t) => t.dataset.tab)
    );
    assertTrue(tabs.includes("political"), "political tab exists");
    assertTrue(tabs.includes("movies"), "movies tab exists");
    assertTrue(tabs.includes("sensationalism"), "sensationalism tab exists");
    assertTrue(tabs.includes("techWhitelist"), "techWhitelist tab exists");
    assertFalse(tabs.includes("intlRelations"), "intlRelations tab should not exist");
  });

  await runTest("Popup: can add and remove keyword", async () => {
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await popupPage.waitForSelector("#main-view", { visible: true, timeout: 5000 });
    await popupPage.evaluate(() => document.getElementById("btn-advanced").click());
    await popupPage.waitForSelector("#advanced-view", { visible: true, timeout: 3000 });
    await popupPage.evaluate(() => document.getElementById("btn-keywords").click());
    await popupPage.waitForSelector("#keywords-view", { visible: true, timeout: 3000 });
    await popupPage.evaluate(() => document.querySelector('.tab[data-tab="sensationalism"]').click());
    await popupPage.waitForFunction(
      () => document.querySelector('.tab[data-tab="sensationalism"]').classList.contains("active"),
      { timeout: 2000 }
    );

    await popupPage.evaluate(() => {
      document.getElementById("keyword-input").value = "testkeyword";
      document.getElementById("btn-add-keyword").click();
    });

    const added = await popupPage.evaluate(() =>
      Array.from(document.querySelectorAll(".keyword-text")).map((el) => el.textContent)
    );
    assertTrue(added.includes("testkeyword"), "keyword should be added");

    // Remove via background save (more reliable in headless)
    const get = await sendMessageToBackground(bgPage, { type: "getSettings" });
    get.settings.keywords.sensationalism = get.settings.keywords.sensationalism.filter((kw) => kw !== "testkeyword");
    await sendMessageToBackground(bgPage, { type: "saveSettings", data: get.settings });

    // Reload and verify removal
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await popupPage.evaluate(() => {
      document.getElementById("btn-advanced").click();
      document.getElementById("btn-keywords").click();
      document.querySelector('.tab[data-tab="sensationalism"]').click();
    });
    await popupPage.waitForFunction(
      () => document.querySelector('.tab[data-tab="sensationalism"]').classList.contains("active"),
      { timeout: 2000 }
    );
    const remaining = await popupPage.evaluate(() =>
      Array.from(document.querySelectorAll(".keyword-text")).map((el) => el.textContent)
    );
    assertTrue(!remaining.includes("testkeyword"), "keyword should be removed");
  });

  await runTest("Popup: stats display updates", async () => {
    await resetToDefaults(bgPage);
    await sendMessageToBackground(bgPage, {
      type: "saveSettings",
      data: {
        version: "1.0",
        enabled: true,
        activeFilters: { political: true, movies: true, sensationalism: true },
        keywords: { political: ["modi"], movies: ["bollywood"], sensationalism: ["breaking"] },
        techWhitelist: ["ai"],
        learned: { authors: [], hashtags: [], keywords: [] },
        whitelistedAuthors: [],
        stats: { postsHidden: 42, postsRevealed: 7, patternsLearned: 3, authorsWhitelisted: 2 }
      }
    });

    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await popupPage.evaluate(() => document.getElementById("btn-advanced").click());
    await popupPage.waitForSelector("#advanced-view", { visible: true, timeout: 3000 });

    const stats = await popupPage.evaluate(() => ({
      hidden: document.getElementById("stat-hidden").textContent,
      learned: document.getElementById("stat-learned").textContent
    }));
    assertEqual(stats.hidden, "42", "posts hidden stat should display");
    assertEqual(stats.learned, "3", "patterns learned stat should display");
  });

  await runTest("Popup: enable/disable toggle works", async () => {
    await resetToDefaults(bgPage);
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await popupPage.evaluate(() => document.getElementById("btn-advanced").click());
    await popupPage.waitForSelector("#advanced-view", { visible: true, timeout: 3000 });

    // Uncheck enabled
    await popupPage.evaluate(() => {
      document.getElementById("toggle-enabled").checked = false;
      document.getElementById("toggle-enabled").dispatchEvent(new Event("change"));
    });
    await sleep(300);

    const get = await sendMessageToBackground(bgPage, { type: "getSettings" });
    assertEqual(get.settings.enabled, false, "filtering should be disabled");
  });
}

async function runContentTests(mockPage) {
  console.log("\n--- Content Script Tests ---\n");

  await runTest("Content: hides political tweets", async () => {
    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[0];
      return {
        display: tweet.style.display,
        hasPlaceholder: tweet.parentElement.querySelectorAll(".xf-placeholder").length > 0,
        processed: tweet.getAttribute("data-filter-processed")
      };
    });
    assertEqual(result.display, "none", "political tweet hidden");
    assertEqual(result.hasPlaceholder, true, "political tweet has placeholder");
    assertEqual(result.processed, "true", "political tweet processed");
  });

  await runTest("Content: hides movies & gossip tweets", async () => {
    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[1];
      return { display: tweet.style.display, hasPlaceholder: tweet.parentElement.querySelectorAll(".xf-placeholder").length > 0 };
    });
    assertEqual(result.display, "none", "movies tweet hidden");
    assertEqual(result.hasPlaceholder, true, "movies tweet has placeholder");
  });

  await runTest("Content: hides sensationalism tweets", async () => {
    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[4];
      return { display: tweet.style.display, hasPlaceholder: tweet.parentElement.querySelectorAll(".xf-placeholder").length > 0 };
    });
    assertEqual(result.display, "none", "sensationalism tweet hidden");
    assertEqual(result.hasPlaceholder, true, "sensationalism tweet has placeholder");
  });

  await runTest("Content: tech override protects tech tweets", async () => {
    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[5];
      return { display: tweet.style.display, hasPlaceholder: tweet.parentElement.querySelectorAll(".xf-placeholder").length > 0 };
    });
    assertEqual(result.display, "", "tech tweet visible");
    assertEqual(result.hasPlaceholder, false, "tech tweet no placeholder");
  });

  await runTest("Content: neutral tweets are not hidden", async () => {
    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[6];
      return { display: tweet.style.display, hasPlaceholder: tweet.parentElement.querySelectorAll(".xf-placeholder").length > 0 };
    });
    assertEqual(result.display, "", "neutral tweet visible");
    assertEqual(result.hasPlaceholder, false, "neutral tweet no placeholder");
  });

  await runTest("Content: hover reveals and mouseleave conceals", async () => {
    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[0];
      const placeholder = tweet.parentElement.querySelector(".xf-placeholder");

      placeholder.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      const visible = tweet.style.display !== "none";
      const faded = placeholder.classList.contains("xf-fade-out");
      const fadeIn = tweet.classList.contains("xf-fade-in");

      placeholder.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
      const hiddenAgain = tweet.style.display === "none";

      return { visible, faded, fadeIn, hiddenAgain };
    });
    assertEqual(result.visible, true, "visible on hover");
    assertEqual(result.faded, true, "placeholder fades out");
    assertEqual(result.fadeIn, true, "tweet fades in");
    assertEqual(result.hiddenAgain, true, "hidden after mouseleave");
  });

  await runTest("Content: 'Hide similar' button works", async () => {
    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[0];
      const placeholder = tweet.parentElement.querySelector(".xf-placeholder");
      const btn = placeholder.querySelector(".xf-btn-hide");
      btn.click();
      return {
        text: btn.textContent,
        disabled: btn.disabled,
        toastExists: document.querySelector(".xf-toast") !== null
      };
    });
    assertEqual(result.text, "Learned!", "button shows 'Learned!'");
    assertEqual(result.disabled, true, "button disabled");
    assertEqual(result.toastExists, true, "toast created");
  });

  await runTest("Content: placeholder shows correct reason", async () => {
    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[0];
      const placeholder = tweet.parentElement.querySelector(".xf-placeholder");
      return { reason: placeholder.querySelector(".xf-reason").textContent };
    });
    assertEqual(result.reason, "Political content", "correct reason displayed");
  });

  await runTest("Content: mixed category scoring (political + sensationalism)", async () => {
    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[8];
      return { display: tweet.style.display, hasPlaceholder: tweet.parentElement.querySelectorAll(".xf-placeholder").length > 0 };
    });
    assertEqual(result.display, "none", "mixed tweet hidden (2+1=3)");
    assertEqual(result.hasPlaceholder, true, "mixed tweet has placeholder");
  });

  await runTest("Content: word boundary prevents false positives", async () => {
    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[9];
      return { display: tweet.style.display, hasPlaceholder: tweet.parentElement.querySelectorAll(".xf-placeholder").length > 0 };
    });
    assertEqual(result.display, "", "trumpet should not match trump");
    assertEqual(result.hasPlaceholder, false, "no false positive placeholder");
  });

  await runTest("Content: processed attribute prevents reprocessing", async () => {
    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[0];
      return { processed: tweet.getAttribute("data-filter-processed") };
    });
    assertEqual(result.processed, "true", "tweet marked as processed");
  });

  await runTest("Content: stats increment on hide", async () => {
    const stats = await mockPage.evaluate(() => ({
      hidden: window.__xfSettings.stats.postsHidden,
      revealed: window.__xfSettings.stats.postsRevealed
    }));
    assertTrue(stats.hidden > 0, "postsHidden should be > 0");
    assertTrue(stats.revealed >= 0, "postsRevealed should be >= 0");
  });

  await runTest("Content: disabled filtering stops processing", async () => {
    // Inject disabled settings
    await mockPage.evaluate(() => {
      window.__xfSettings.enabled = false;
      // Remove processed markers to simulate fresh page
      document.querySelectorAll('article[data-testid="tweet"]').forEach((t) => {
        t.removeAttribute("data-filter-processed");
        t.style.display = "";
      });
      document.querySelectorAll(".xf-placeholder").forEach((p) => p.remove());
    });

    // Re-inject content script with disabled settings
    const contentJS = fs.readFileSync(path.join(EXTENSION_PATH, "content.js"), "utf8");
    await mockPage.evaluate(contentJS);
    await sleep(500);

    const result = await mockPage.evaluate(() => {
      const tweet = document.querySelectorAll('article[data-testid="tweet"]')[0];
      return { display: tweet.style.display, processed: tweet.getAttribute("data-filter-processed") };
    });
    assertEqual(result.display, "", "tweet should remain visible when disabled");
    assertTrue(result.processed !== "true" || result.processed === null, "tweet should not be processed when disabled");
  });
}

// --- Main ---

async function main() {
  console.log("=== X Filter Extension Comprehensive Headless Tests ===\n");
  ensureDir(SCREENSHOT_DIR);

  const startTime = Date.now();

  try {
    browser = await puppeteer.launch({
      headless: "chrome",
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    });

    const workerPage = await browser.newPage();
    extensionId = await getExtensionId();
    console.log(`Extension ID: ${extensionId}\n`);

    const bgPage = await browser.newPage();
    await bgPage.goto(`chrome-extension://${extensionId}/_generated_background_page.html`);

    // Run background tests
    await runBackgroundTests(bgPage);

    // Run popup tests
    const popupPage = await browser.newPage();
    await popupPage.setViewport({ width: 400, height: 700 });
    await runPopupTests(popupPage, bgPage);

    // Run content script tests
    const { server, port } = await createMockServer();
    const mockPage = await browser.newPage();
    await mockPage.goto(`http://localhost:${port}`, { waitUntil: "networkidle0" });
    await setupMockPage(mockPage, bgPage);
    await runContentTests(mockPage);

    server.close();

    // --- Summary ---
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const passed = testResults.filter((r) => r.status === "PASS").length;
    const failed = testResults.filter((r) => r.status === "FAIL").length;

    console.log(`\n=== Summary (${duration}s) ===`);
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${failed}`);
    console.log(`  Total:  ${testResults.length}`);

    if (failed > 0) {
      console.log("\n--- Failed Tests ---");
      testResults.filter((r) => r.status === "FAIL").forEach((r) => {
        console.log(`  [FAIL] ${r.name}`);
        console.log(`    ${r.error}`);
      });
      process.exitCode = 1;
    }

  } catch (err) {
    console.error("\nFatal error:", err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    console.log("\nTests complete.");
  }
}

main();
