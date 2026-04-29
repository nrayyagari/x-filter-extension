const puppeteer = require("puppeteer");
const path = require("path");
const http = require("http");
const fs = require("fs");

const EXTENSION_PATH = path.resolve(__dirname, "..");
const MOCK_PAGE = path.resolve(__dirname, "mock-x-timeline.html");

let browser, page, server;

async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(MOCK_PAGE));
    });
    server.listen(0, () => {
      resolve(server.address().port);
    });
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTests() {
  console.log("=== X Filter Integration Tests ===\n");

  const port = await startServer();
  console.log(`Mock server started on port ${port}`);

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

    page = await browser.newPage();
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle0" });

    // Inject the content script and CSS manually since we're on localhost, not x.com
    const contentJS = fs.readFileSync(path.join(EXTENSION_PATH, "content.js"), "utf8");
    const contentCSS = fs.readFileSync(path.join(EXTENSION_PATH, "content.css"), "utf8");

    // First inject default settings, then the content script
    await page.evaluate((css) => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
    }, contentCSS);

    // The content script uses chrome.runtime which won't work outside extension context.
    // We need to inject settings and override the messaging.
    await page.evaluate(`
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

      // Mock chrome.runtime for content script
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
            } else if (msg.type === "learnHideSimilar" || msg.type === "whitelistAuthor") {
              if (cb) cb({ success: true });
            } else {
              if (cb) cb({});
            }
          },
          onMessage: {
            addListener: function() {}
          }
        }
      };
    `);

    // Now inject the content script
    await page.evaluate(contentJS);

    // Wait for processing
    await sleep(2000);

    const results = await page.evaluate(() => {
      const tweets = document.querySelectorAll('article[data-testid="tweet"]');
      const testResults = [];

      tweets.forEach((tweet, index) => {
        const textEl = tweet.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.textContent : "";
        const isVisible = tweet.style.display !== "none";
        const hasPlaceholder = tweet.parentElement ? (tweet.parentElement.querySelectorAll(".xf-placeholder").length > 0 ||
                               (tweet.previousElementSibling && tweet.previousElementSibling.classList.contains("xf-placeholder"))) : false;
        const processed = tweet.getAttribute("data-xf-processed") === "true";

        testResults.push({
          index,
          text: text.substring(0, 80) + (text.length > 80 ? "..." : ""),
          visible: isVisible,
          hasPlaceholder,
          processed,
        });
      });

      return testResults;
    });

    console.log("\n--- Tweet Processing Results ---\n");

    const expected = [
      { index: 0, shouldHide: true, reason: "Political" },
      { index: 1, shouldHide: true, reason: "Movies & Gossip" },
      { index: 2, shouldHide: false, reason: "Out of scope international relations" },
      { index: 3, shouldHide: false, reason: "Out of scope international relations" },
      { index: 4, shouldHide: true, reason: "Sensationalism" },
      { index: 5, shouldHide: false, reason: "Tech override" },
      { index: 6, shouldHide: false, reason: "Neutral" },
      { index: 7, shouldHide: false, reason: "Tech" },
      { index: 8, shouldHide: true, reason: "Mixed" },
      { index: 9, shouldHide: false, reason: "Word boundary" },
      { index: 10, shouldHide: false, reason: "Out of scope international relations" },
    ];

    let passed = 0;
    let failed = 0;

    results.forEach((result, i) => {
      const exp = expected[i];
      if (!exp) return;
      const actualHidden = !result.visible;
      const status = actualHidden === exp.shouldHide ? "PASS" : "FAIL";
      if (status === "PASS") passed++;
      else failed++;

      console.log(
        `[${status}] Tweet ${i}: ${exp.reason}\n` +
        `  Text: "${result.text}"\n` +
        `  Expected: ${exp.shouldHide ? "HIDDEN" : "VISIBLE"} | Actual: ${result.visible ? "VISIBLE" : "HIDDEN"} | Processed: ${result.processed} | Placeholder: ${result.hasPlaceholder}\n`
      );
    });

    console.log(`\n--- Summary ---`);
    console.log(`  Passed: ${passed}/${expected.length}`);
    console.log(`  Failed: ${failed}/${expected.length}`);
    console.log(`  Total:  ${expected.length}`);

    const placeholderCount = await page.evaluate(() => {
      return document.querySelectorAll(".xf-placeholder").length;
    });
    console.log(`\n  Placeholders rendered: ${placeholderCount}`);

  } catch (err) {
    console.error("Test error:", err.message);
    console.error(err.stack);
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
    console.log("\nTests complete.");
  }
}

runTests();
