import type { ProtestEvent } from "./api";

/**
 * Derive a human-readable headline from a news article URL. Most news sites
 * embed the headline as a hyphenated slug in the path; GDELT gives us the URL
 * but not the article title, so this recovers it for the common case.
 */
export function headlineFromUrl(url: string | null): string | null {
  if (!url) return null;
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  // Pick the most headline-like path segment: the one with the most hyphens.
  let best = "";
  let bestHyphens = 2; // require at least 3 words
  for (const seg of path.split("/")) {
    const clean = seg.replace(/\.(html?|php|aspx?|cfm|stm)$/i, "");
    const hyphens = (clean.match(/[-_]/g) ?? []).length;
    if (hyphens >= bestHyphens && clean.length > best.length) {
      best = clean;
      bestHyphens = hyphens;
    }
  }
  if (!best) return null;
  // Ids and timestamps often cling to the slug edges ("12345.headline-…",
  // "…-students20260807005407"); shave digit runs off both ends.
  best = best.replace(/^[\d.]+/, "").replace(/\d{6,}$/, "");

  let words = best.split(/[-_]+/).filter(Boolean);
  // Trim ids, dates, and section prefixes that cling to the slug edges.
  while (words.length && /^\d+$/.test(words[0])) words.shift();
  while (words.length && /^\d+$/.test(words[words.length - 1])) words.pop();
  words = words.filter((w) => w.length < 30);
  if (words.length < 3) return null;

  const text = words.join(" ");
  if (text.length < 15 || /^\d[\d\s]*$/.test(text)) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Best available headline: real article title, then URL slug, then actors. */
export function eventHeadline(e: ProtestEvent): string {
  if (e.title) return e.title;
  const fromUrl = headlineFromUrl(e.source_url);
  if (fromUrl) return fromUrl;
  if (e.actor1_name && e.actor2_name)
    return `${title(e.actor1_name)} vs ${title(e.actor2_name)} protest`;
  const where = e.location_name ?? "unknown location";
  return `Protest in ${where}`;
}

function title(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
