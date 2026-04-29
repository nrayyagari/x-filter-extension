export const KEYWORDS = {
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
};

export const TECH_WHITELIST = [
  "developer", "programming", "code", "coding", "software", "ai",
  "artificial intelligence", "machine learning", "deep learning",
  "open source", "github", "gitlab", "kubernetes", "docker", "aws",
  "azure", "gcp", "cloud", "cloud computing", "api", "rest api",
  "graphql", "microservices", "serverless", "devops", "sre", "database",
  "sql", "nosql", "linux", "ubuntu", "python", "javascript", "typescript",
  "react", "node.js", "go", "rust", "java", "nvidia", "gpu", "cpu",
  "tech", "technology", "startup", "funding", "series a", "saas", "infra",
  "infrastructure", "system design"
];

export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function keywordMatch(text, keyword) {
  const kw = keyword.toLowerCase();
  if (kw.includes(" ")) {
    return text.includes(kw);
  }
  return new RegExp("\\b" + escapeRegex(kw) + "\\b").test(text);
}

export function scoreTweet(text, author, hashtags, activeFilters, learnedAuthors, learnedHashtags, learnedKeywords, whitelistedAuthors, techWhitelist) {
  const lowerText = text.toLowerCase();

  if (author && whitelistedAuthors.includes(author)) {
    return { hidden: false, reason: "", score: 0 };
  }

  for (const term of (techWhitelist || TECH_WHITELIST)) {
    if (term.includes(" ")) {
      if (lowerText.includes(term.toLowerCase())) {
        return { hidden: false, reason: "", score: 0 };
      }
    } else if (new RegExp("\\b" + escapeRegex(term.toLowerCase()) + "\\b").test(lowerText)) {
      return { hidden: false, reason: "", score: 0 };
    }
  }

  let score = 0;
  let reason = "";

  if (activeFilters.political) {
    for (const kw of KEYWORDS.political) {
      if (keywordMatch(lowerText, kw)) {
        score += 2;
        if (!reason) reason = "Political content";
      }
    }
  }

  if (activeFilters.movies) {
    for (const kw of KEYWORDS.movies) {
      if (keywordMatch(lowerText, kw)) {
        score += 2;
        if (!reason) reason = "Movies & Gossip";
      }
    }
  }

  if (activeFilters.sensationalism) {
    for (const kw of KEYWORDS.sensationalism) {
      if (keywordMatch(lowerText, kw)) {
        score += 1;
        if (!reason && score >= 3) reason = "Sensationalism";
      }
    }
  }

  for (const a of (learnedAuthors || [])) {
    if (a === author) {
      score += 3;
      if (!reason) reason = "Learned author";
    }
  }

  for (const tag of (hashtags || [])) {
    if ((learnedHashtags || []).includes(tag)) {
      score += 2;
      if (!reason) reason = "Learned hashtag";
    }
  }

  for (const kw of (learnedKeywords || [])) {
    if (keywordMatch(lowerText, kw)) {
      score += 1;
    }
  }

  return {
    hidden: score >= 3,
    reason: reason || "Filtered content",
    score
  };
}
