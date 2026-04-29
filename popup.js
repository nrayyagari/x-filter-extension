let settings = null;
let currentKeywordTab = "political";
let currentAuthorsMode = "blocked";

const views = ["main-view", "advanced-view", "keywords-view", "authors-view", "export-view"];

function showView(viewId) {
  views.forEach((v) => {
    document.getElementById(v).classList.toggle("hidden", v !== viewId);
  });
}

function init() {
  chrome.runtime.sendMessage({ type: "getSettings" }, (response) => {
    settings = response.settings;
    renderMainView();
  });
}

function renderMainView() {
  document.getElementById("filter-political").checked = settings.activeFilters.political;
  document.getElementById("filter-movies").checked = settings.activeFilters.movies;
  document.getElementById("filter-sensationalism").checked = settings.activeFilters.sensationalism;
}

function renderAdvancedView() {
  document.getElementById("toggle-enabled").checked = settings.enabled;
  document.getElementById("stat-hidden").textContent = settings.stats.postsHidden.toLocaleString();
  document.getElementById("stat-learned").textContent = settings.stats.patternsLearned;
}

function renderKeywordsView() {
  const list = document.getElementById("keyword-list");
  list.innerHTML = "";

  const keywords = currentKeywordTab === "techWhitelist"
    ? settings.techWhitelist
    : settings.keywords[currentKeywordTab];

  keywords.forEach((kw, index) => {
    const item = document.createElement("div");
    item.className = "keyword-item";
    item.innerHTML = `
      <span class="keyword-text">${escapeHtml(kw)}</span>
      <button class="btn btn-remove" data-index="${index}">&times;</button>
    `;
    item.querySelector(".btn-remove").addEventListener("click", () => {
      if (currentKeywordTab === "techWhitelist") {
        settings.techWhitelist.splice(index, 1);
      } else {
        settings.keywords[currentKeywordTab].splice(index, 1);
      }
      saveAndRefresh();
    });
    list.appendChild(item);
  });
}

function renderAuthorsView() {
  const list = document.getElementById("author-list");
  list.innerHTML = "";

  const authors = currentAuthorsMode === "blocked"
    ? settings.learned.authors
    : settings.whitelistedAuthors;

  document.getElementById("authors-view-icon").innerHTML =
    currentAuthorsMode === "blocked" ? "&#x1F6AB;" : "&#x2714;";
  document.getElementById("authors-view-title").textContent =
    currentAuthorsMode === "blocked" ? "Blocked Authors" : "Whitelisted Authors";

  authors.forEach((author, index) => {
    const item = document.createElement("div");
    item.className = "keyword-item";
    item.innerHTML = `
      <span class="keyword-text">${escapeHtml(author)}</span>
      <button class="btn btn-remove" data-index="${index}">&times;</button>
    `;
    item.querySelector(".btn-remove").addEventListener("click", () => {
      if (currentAuthorsMode === "blocked") {
        settings.learned.authors.splice(index, 1);
      } else {
        settings.whitelistedAuthors.splice(index, 1);
      }
      saveAndRefresh();
    });
    list.appendChild(item);
  });
}

function saveAndRefresh() {
  chrome.runtime.sendMessage({ type: "saveSettings", data: settings }, () => {
    // Broadcast settings update to all X.com / Twitter tabs
    chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] }, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: "settingsUpdated", data: settings }, () => {
            // Ignore errors (tab might not have content script loaded yet)
            chrome.runtime.lastError;
          });
        }
      });
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Event listeners
document.getElementById("btn-block").addEventListener("click", () => {
  settings.activeFilters.political = document.getElementById("filter-political").checked;
  settings.activeFilters.movies = document.getElementById("filter-movies").checked;
  settings.activeFilters.sensationalism = document.getElementById("filter-sensationalism").checked;
  saveAndRefresh();
  const btn = document.getElementById("btn-block");
  btn.textContent = "Saved!";
  btn.classList.add("btn-saved");
  setTimeout(() => {
    btn.textContent = "Block";
    btn.classList.remove("btn-saved");
  }, 1500);
});

document.getElementById("btn-advanced").addEventListener("click", () => {
  renderAdvancedView();
  showView("advanced-view");
});

document.getElementById("toggle-enabled").addEventListener("change", (e) => {
  settings.enabled = e.target.checked;
  saveAndRefresh();
});

document.getElementById("btn-rescan").addEventListener("click", () => {
  const btn = document.getElementById("btn-rescan");
  btn.textContent = "Scanning...";
  btn.disabled = true;
  chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] }, (tabs) => {
    let scanned = 0;
    tabs.forEach((tab) => {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "forceScan" }, (resp) => {
          if (resp?.scanned) scanned++;
        });
      }
    });
    setTimeout(() => {
      btn.textContent = "&#x1F504; Force Re-scan Now";
      btn.disabled = false;
    }, 1000);
  });
});

document.getElementById("btn-keywords").addEventListener("click", () => {
  currentKeywordTab = "political";
  updateTabHighlight();
  renderKeywordsView();
  showView("keywords-view");
});

document.getElementById("btn-blocked-authors").addEventListener("click", () => {
  currentAuthorsMode = "blocked";
  renderAuthorsView();
  showView("authors-view");
});

document.getElementById("btn-whitelisted-authors").addEventListener("click", () => {
  currentAuthorsMode = "whitelisted";
  renderAuthorsView();
  showView("authors-view");
});

document.getElementById("btn-export-import").addEventListener("click", () => {
  showView("export-view");
});

document.getElementById("btn-reset").addEventListener("click", () => {
  if (confirm("Reset all learned patterns? This cannot be undone.")) {
    chrome.runtime.sendMessage({ type: "resetLearned" }, () => {
      settings.learned = { authors: [], hashtags: [], keywords: [] };
      renderAdvancedView();
    });
  }
});

document.getElementById("btn-back").addEventListener("click", () => {
  renderMainView();
  showView("main-view");
});

// Keywords view
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    currentKeywordTab = tab.dataset.tab;
    updateTabHighlight();
    renderKeywordsView();
  });
});

function updateTabHighlight() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === currentKeywordTab);
  });
}

document.getElementById("btn-add-keyword").addEventListener("click", () => {
  const input = document.getElementById("keyword-input");
  const value = input.value.trim().toLowerCase();
  if (!value) return;

  if (currentKeywordTab === "techWhitelist") {
    if (!settings.techWhitelist.includes(value)) {
      settings.techWhitelist.push(value);
    }
  } else {
    if (!settings.keywords[currentKeywordTab].includes(value)) {
      settings.keywords[currentKeywordTab].push(value);
    }
  }
  input.value = "";
  saveAndRefresh();
  renderKeywordsView();
});

document.getElementById("keyword-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    document.getElementById("btn-add-keyword").click();
  }
});

document.getElementById("btn-keywords-back").addEventListener("click", () => {
  renderAdvancedView();
  showView("advanced-view");
});

// Authors view
document.getElementById("btn-add-author").addEventListener("click", () => {
  const input = document.getElementById("author-input");
  let value = input.value.trim();
  if (!value.startsWith("@")) value = "@" + value;

  if (currentAuthorsMode === "blocked") {
    if (!settings.learned.authors.includes(value)) {
      settings.learned.authors.push(value);
    }
  } else {
    if (!settings.whitelistedAuthors.includes(value)) {
      settings.whitelistedAuthors.push(value);
    }
  }
  input.value = "";
  saveAndRefresh();
  renderAuthorsView();
});

document.getElementById("author-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    document.getElementById("btn-add-author").click();
  }
});

document.getElementById("btn-authors-back").addEventListener("click", () => {
  renderAdvancedView();
  showView("advanced-view");
});

// Export/Import
document.getElementById("btn-export").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "exportSettings" }, (response) => {
    const blob = new Blob([JSON.stringify(response.settings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "x-filter-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  });
});

document.getElementById("btn-import").addEventListener("click", () => {
  document.getElementById("import-file").click();
});

document.getElementById("import-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const imported = JSON.parse(event.target.result);
      if (!imported.version) throw new Error("Invalid settings format");

      chrome.runtime.sendMessage({ type: "importSettings", data: imported }, (response) => {
        const statusEl = document.getElementById("import-status");
        if (response.success) {
          settings = response.settings;
          statusEl.textContent = "Settings imported successfully!";
          statusEl.className = "status-success";
          chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] }, (tabs) => {
            tabs.forEach((tab) => {
              if (tab.id) {
                chrome.tabs.sendMessage(tab.id, { type: "settingsUpdated", data: settings }, () => {
                  chrome.runtime.lastError;
                });
              }
            });
          });
        } else {
          statusEl.textContent = "Import failed: " + (response.error || "Unknown error");
          statusEl.className = "status-error";
        }
      });
    } catch (err) {
      const statusEl = document.getElementById("import-status");
      statusEl.textContent = "Invalid JSON: " + err.message;
      statusEl.className = "status-error";
    }
  };
  reader.readAsText(file);
});

document.getElementById("btn-export-back").addEventListener("click", () => {
  renderAdvancedView();
  showView("advanced-view");
});

init();
