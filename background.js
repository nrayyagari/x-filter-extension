const DEFAULTS = {
  version: "1.0",
  enabled: true,
  activeFilters: { political: true, movies: true, sensationalism: true, intlRelations: true },
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
    ],
    intlRelations: [
      "trump", "donald trump", "iran war", "iran attack", "iran nuclear",
      "russia ukraine", "ukraine war", "ukraine conflict", "russia invasion",
      "putin", "zelensky", "nato", "nato expansion", "sanctions russia",
      "israel gaza", "gaza war", "gaza conflict", "israel hamas",
      "middle east crisis", "middle east conflict", "syria war", "syria conflict",
      "china taiwan", "taiwan strait", "china aggression",
      "north korea", "kim jong un", "nuclear threat",
      "taleban", "afghanistan crisis", "afghanistan war",
      "foreign policy", "diplomatic crisis", "geopolitics",
      "war crimes", "military strike", "air strike", "missile attack",
      "refugee crisis", "humanitarian crisis", "un security council",
      "world war", "nuclear war", "military conflict", "armed conflict",
      "ceasefire", "peace talks", "war escalation", "troop deployment"
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

function getDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("settings", (result) => {
    if (!result.settings) {
      chrome.storage.local.set({ settings: getDefaults() });
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "learnHideSimilar") {
    handleLearnHideSimilar(message.data, sendResponse);
    return true;
  }

  if (message.type === "whitelistAuthor") {
    handleWhitelistAuthor(message.data, sendResponse);
    return true;
  }

  if (message.type === "getSettings") {
    chrome.storage.local.get("settings", (result) => {
      sendResponse({ settings: result.settings || getDefaults() });
    });
    return true;
  }

  if (message.type === "updateStats") {
    chrome.storage.local.get("settings", (result) => {
      const settings = result.settings || getDefaults();
      settings.stats.postsHidden = message.data.postsHidden;
      settings.stats.postsRevealed = message.data.postsRevealed;
      chrome.storage.local.set({ settings }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (message.type === "saveSettings") {
    chrome.storage.local.set({ settings: message.data }, () => {
      enforceStorageLimits();
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === "resetLearned") {
    chrome.storage.local.get("settings", (result) => {
      const settings = result.settings || getDefaults();
      settings.learned = { authors: [], hashtags: [], keywords: [] };
      chrome.storage.local.set({ settings }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (message.type === "exportSettings") {
    chrome.storage.local.get("settings", (result) => {
      sendResponse({ settings: result.settings || getDefaults() });
    });
    return true;
  }

  if (message.type === "importSettings") {
    try {
      const settings = message.data;
      if (!settings.version) throw new Error("Invalid settings format");
      chrome.storage.local.set({ settings }, () => {
        enforceStorageLimits();
        sendResponse({ success: true });
      });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }
});

function handleLearnHideSimilar(data, sendResponse) {
  chrome.storage.local.get("settings", (result) => {
    const settings = result.settings || getDefaults();
    let learned = false;

    if (data.author && !settings.learned.authors.includes(data.author)) {
      settings.learned.authors.push(data.author);
      learned = true;
    }

    if (data.hashtags) {
      data.hashtags.forEach((tag) => {
        if (!settings.learned.hashtags.includes(tag)) {
          settings.learned.hashtags.push(tag);
          learned = true;
        }
      });
    }

    if (data.text) {
      const words = data.text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
      const learnableWords = words.filter((w) => w.length >= 5);
      const STOP_WORDS = new Set(["their", "there", "these", "those", "about", "would", "could", "should", "which", "where", "while", "after", "before", "between", "through", "during", "without", "within", "along", "being", "doing", "having", "going", "coming", "looking", "getting", "making", "taking", "giving", "something", "nothing", "everything", "anything", "already", "another", "because", "however", "whether", "although", "instead", "really", "actually", "probably", "usually", "always", "never", "every", "since", "until", "again", "still", "also", "very", "much", "more", "most", "other", "first", "last", "only", "just", "than", "that", "this", "what", "when", "where", "which", "whose", "those", "these", "being", "since", "every"]);
      learnableWords.slice(0, 5).forEach((word) => {
        if (!STOP_WORDS.has(word) && !settings.learned.keywords.includes(word)) {
          settings.learned.keywords.push(word);
          learned = true;
        }
      });
    }

    if (learned) {
      settings.stats.patternsLearned++;
    }

    chrome.storage.local.set({ settings }, () => {
      enforceStorageLimits();
      sendResponse({ success: true, learned });
    });
  });
}

function handleWhitelistAuthor(data, sendResponse) {
  chrome.storage.local.get("settings", (result) => {
    const settings = result.settings || getDefaults();
    if (!settings.whitelistedAuthors.includes(data.author)) {
      settings.whitelistedAuthors.push(data.author);
      settings.stats.authorsWhitelisted++;
      chrome.storage.local.set({ settings }, () => {
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: true, alreadyWhitelisted: true });
    }
  });
}

function enforceStorageLimits() {
  chrome.storage.local.get("settings", (result) => {
    const settings = result.settings;
    if (!settings) return;

    const MAX_PER_LIST = 2000;
    let trimmed = false;

    ["authors", "hashtags", "keywords"].forEach((key) => {
      if (settings.learned[key].length > MAX_PER_LIST) {
        settings.learned[key] = settings.learned[key].slice(-MAX_PER_LIST);
        trimmed = true;
      }
    });

    if (settings.whitelistedAuthors.length > MAX_PER_LIST) {
      settings.whitelistedAuthors = settings.whitelistedAuthors.slice(-MAX_PER_LIST);
      trimmed = true;
    }

    if (trimmed) {
      chrome.storage.local.set({ settings });
    }
  });
}