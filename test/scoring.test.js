import { describe, it, expect } from "vitest";
import { scoreTweet, keywordMatch, KEYWORDS, TECH_WHITELIST } from "./scoring.js";

const defaultFilters = { political: true, movies: true, sensationalism: true, intlRelations: true };
const noFilters = { political: false, movies: false, sensationalism: false, intlRelations: false };

function score(text, author = "", hashtags = [], filters = defaultFilters, learned = {}) {
  return scoreTweet(
    text, author, hashtags, filters,
    learned.authors || [],
    learned.hashtags || [],
    learned.keywords || [],
    learned.whitelistedAuthors || [],
    TECH_WHITELIST
  );
}

describe("keywordMatch", () => {
  it("matches single words with word boundaries", () => {
    expect(keywordMatch("the pm announced", "pm")).toBe(true);
    expect(keywordMatch("empty prompt value", "pm")).toBe(false);
    expect(keywordMatch("the cmp register", "mp")).toBe(false);
    expect(keywordMatch("this hit that", "hit")).toBe(true);
    expect(keywordMatch("empty", "mp")).toBe(false);
  });

  it("matches multi-word phrases with includes", () => {
    expect(keywordMatch("russia ukraine war latest", "russia ukraine")).toBe(true);
    expect(keywordMatch("cloud computing is great", "cloud computing")).toBe(true);
  });
});

describe("Political filtering", () => {
  it("hides tweets with multiple political keywords (score >= 3)", () => {
    const result = score("Modi announces new parliament bill for cabinet ministry in Andhra Pradesh");
    expect(result.hidden).toBe(true);
    expect(result.reason).toBe("Political content");
  });

  it("does not hide text with only one low-scoring match", () => {
    const result = score("Just a random thought about the weather today");
    expect(result.hidden).toBe(false);
  });

  it("hides political content when multiple keywords cross threshold", () => {
    const result = score("BJP and Congress debate election vote");
    expect(result.hidden).toBe(true);
  });

  it("hides with multiple political keywords crossing threshold", () => {
    const result = score("BJP and Congress debate election vote");
    expect(result.hidden).toBe(true);
  });

  it("does not hide when political filter is disabled", () => {
    const filters = { ...defaultFilters, political: false };
    const result = score("Modi announces new parliament bill", "", [], filters);
    expect(result.hidden).toBe(false);
  });
});

describe("Movies & Gossip filtering", () => {
  it("hides Tollywood gossip tweets", () => {
    const result = score("Tollywood hero box office collections blockbuster hit gossip scandal");
    expect(result.hidden).toBe(true);
    expect(result.reason).toBe("Movies & Gossip");
  });

  it("does not hide single movie keyword (score=2)", () => {
    const result = score("The director of this project is great");
    expect(result.hidden).toBe(false);
  });

  it("hides Bollywood gossip", () => {
    const result = score("Bollywood actor actress gossip scandal leaked");
    expect(result.hidden).toBe(true);
  });
});

describe("Sensationalism filtering", () => {
  it("hides combined sensationalism keywords (score=3)", () => {
    const result = score("BREAKING shocking exposed truth revealed must watch viral trending");
    expect(result.hidden).toBe(true);
  });

  it("hides exactly 3 sensationalism keywords", () => {
    const result = score("breaking shocking exposed");
    expect(result.hidden).toBe(true);
  });

  it("does not hide with just 1 sensational keyword (score=1)", () => {
    const result = score("This is a breaking story about tech");
    expect(result.hidden).toBe(false);
  });
});

describe("International Relations filtering", () => {
  it("hides tweets with Trump and intl relations keywords", () => {
    const result = score("Trump announces foreign policy and diplomatic crisis");
    expect(result.hidden).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it("hides Russia-Ukraine war tweets", () => {
    const result = score("Russia Ukraine war escalation troop deployment military strike");
    expect(result.hidden).toBe(true);
  });

  it("hides Iran war tweets", () => {
    const result = score("Iran war nuclear threat missile attack ceasefire");
    expect(result.hidden).toBe(true);
  });

  it("hides Israel-Gaza tweets", () => {
    const result = score("Israel Gaza conflict humanitarian crisis peace talks");
    expect(result.hidden).toBe(true);
  });

  it("does not hide when intl relations filter is off", () => {
    const filters = { ...defaultFilters, intlRelations: false };
    const result = score("Trump Putin diplomatic crisis", "", [], filters);
    expect(result.hidden).toBe(false);
  });

  it("word-boundary: 'trumpet' does not match 'trump'", () => {
    const result = score("The trumpet concert was amazing last night");
    expect(result.hidden).toBe(false);
  });
});

describe("Tech protection override", () => {
  it("never hides tweets with tech keywords even if political", () => {
    const result = score("Modi announces new AI and Kubernetes policy for cloud computing");
    expect(result.hidden).toBe(false);
  });

  it("protects tweets with programming terms", () => {
    const result = score("Working with Python and JavaScript on a new programming project");
    expect(result.hidden).toBe(false);
  });

  it("protects tweets with single tech word with word boundary", () => {
    const result = score("Just deployed a new docker container with AWS");
    expect(result.hidden).toBe(false);
  });

  it("multi-word tech phrases work", () => {
    const result = score("Learning about machine learning and artificial intelligence");
    expect(result.hidden).toBe(false);
  });

  it("'apt' should not match as tech 'api' (word boundary)", () => {
    const result = score("adapt the government policy for election", "", [], defaultFilters);
    expect(result.hidden).toBe(true);
  });
});

describe("Whitelisted authors", () => {
  it("never hides whitelisted author tweets", () => {
    const learned = { whitelistedAuthors: ["@techcrunch"] };
    const result = score("BJP Congress election parliament", "@techcrunch", [], defaultFilters, learned);
    expect(result.hidden).toBe(false);
  });
});

describe("Learned patterns", () => {
  it("hides tweets from learned authors (score=3)", () => {
    const learned = { authors: ["@newschannel"] };
    const result = score("Some random text here", "@newschannel", [], defaultFilters, learned);
    expect(result.hidden).toBe(true);
    expect(result.reason).toBe("Learned author");
  });

  it("learned hashtags alone score=2 does not hide", () => {
    const learned = { hashtags: ["#Election2024"] };
    const result = score("Some text about things", "@user", ["#Election2024"], defaultFilters, learned);
    expect(result.score).toBe(2);
    expect(result.hidden).toBe(false);
  });

  it("learned hashtags + learned keywords combine to threshold", () => {
    const learned = { hashtags: ["#Politics"], keywords: ["corruption"] };
    const result = score("Corruption in the system", "@user", ["#Politics"], defaultFilters, learned);
    expect(result.hidden).toBe(true);
  });
});

describe("Edge cases", () => {
  it("empty text is not hidden", () => {
    const result = score("");
    expect(result.hidden).toBe(false);
  });

  it("neutral text is not hidden", () => {
    const result = score("The weather is nice today, going for a walk in the park");
    expect(result.hidden).toBe(false);
  });

  it("case-insensitive matching", () => {
    const result = score("MODI and BJP and CONGRESS debate");
    expect(result.hidden).toBe(true);
  });

  it("short false-positive keywords are word-matched, not substrings", () => {
    expect(keywordMatch("comptroller", "mp")).toBe(false);
    expect(keywordMatch("prompt delivery", "pm")).toBe(false);
    expect(keywordMatch("empty", "mp")).toBe(false);
  });

  it("all filters off means nothing hidden", () => {
    const result = score("Modi BJP Congress election parliament", "", [], noFilters);
    expect(result.hidden).toBe(false);
  });

  it("mixed categories combine scores", () => {
    const result = score("BJP demands breaking news about controversy");
    expect(result.hidden).toBe(true);
  });
});