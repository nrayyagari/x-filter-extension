# X Filter — Political & Gossip Blocker for X.com

A Chrome extension that filters out political discourse, movie gossip, international relations noise, and sensationalist content from your X.com (Twitter) timeline while preserving tech-related posts.

## Features

- **Four filter categories** — Political, Movies & Gossip, Sensationalism, International Relations — each toggleable independently
- **Weighted scoring engine** — Political/Movie/Intl Relations keywords score +2, sensationalism +1, learned authors +3; posts hidden at score ≥3
- **Tech protection override** — Posts containing tech terms (Kubernetes, AI, programming, etc.) are never hidden regardless of other matches
- **Learn from mistakes** — "Hide similar" learns the author, hashtags, and keywords from a filtered post to improve future filtering
- **Whitelist authors** — "Always show @author" permanently protects an author's posts from filtering
- **Hover to reveal** — Hover over a placeholder to temporarily see the hidden post
- **Keyboard shortcut** — `Shift+H` on a focused tweet triggers "Hide similar"
- **Popup UI** — Category checklist, advanced settings, keyword editor, author management, stats dashboard
- **Export/Import** — Save and restore all settings as JSON
- **100% local** — No external APIs, no cloud sync, no analytics. All data stays in `chrome.storage.local`

## Install

1. Clone this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the `x-filter-extension` directory
5. Open `x.com` — filtering starts automatically

## Usage

| Action | How |
|---|---|
| Toggle filter categories | Click extension icon → check/uncheck → **Block** |
| Reveal a hidden post | Hover over the gray placeholder |
| Hide similar posts | Click "Hide similar" on a placeholder, or press `Shift+H` |
| Always show an author | Click "✔ Always show @author" on a placeholder |
| Manage keywords | Popup → Advanced Settings → Edit Keywords |
| Manage blocked/whitelisted authors | Popup → Advanced Settings → Blocked/Whitelisted Authors |
| Export settings | Popup → Advanced Settings → Export/Import → Export |
| Import settings | Popup → Advanced Settings → Export/Import → Import |
| Disable filtering | Popup → Advanced Settings → toggle Enable Filtering |

## Architecture

```
x.com page
├── content.js        — MutationObserver, scoring engine, placeholders, hover-reveal
├── content.css       — Placeholder & toast styling
├── background.js     — Storage management, learning signals, LRU eviction
├── popup.html/js/css  — Category checklist, advanced settings, keyword/author management
└── manifest.json     — Manifest V3 config
```

### Scoring Logic

| Match | Points | Active When |
|---|---|---|
| Political keyword | +2 | `activeFilters.political` |
| Movie/gossip keyword | +2 | `activeFilters.movies` |
| Sensationalism keyword | +1 | `activeFilters.sensationalism` |
| International Relations keyword | +2 | `activeFilters.intlRelations` |
| Learned author | +3 | Always |
| Learned hashtag | +2 | Always |
| Learned keyword | +1 | Always |
| Tech protection term | **OVERRIDE** (score = 0) | Always |

**Threshold**: score ≥ 3 → post hidden

Single-word keywords use word-boundary matching (`\b`) to avoid false positives. Multi-word phrases use substring matching.

### Learning from "Hide Similar"

When you click "Hide similar" on a placeholder, the extension sends the tweet's author, hashtags, and up to 5 significant words (≥5 chars, stop-words excluded) to the background script, which adds them to the learned patterns list.

## Tech Stack

- **Manifest V3** Chrome Extension
- Vanilla JavaScript (no build step, no dependencies)
- `chrome.storage.local` for persistence
- `MutationObserver` for real-time DOM scanning
- Debounced batch processing (50ms debounce, 20 tweets/batch)

## Privacy

All data is stored locally in `chrome.storage.local`. No data is sent anywhere. No analytics, no tracking, no external requests.

## License

MIT