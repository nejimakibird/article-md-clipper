import type { LinkCandidate, LinkFilterOptions } from "../types";

export type LinkEvaluation = {
  excluded: boolean;
  reasons: string[];
  score: number;
};

const ARTICLE_THRESHOLD = 3;

const STATIC_ASSET_EXTENSIONS =
  /\.(avif|css|gif|ico|jpe?g|js|json|mp3|mp4|png|svg|webp|woff2?|xml)(\?|$)/i;

export const DEFAULT_LINK_FILTERS: LinkFilterOptions = {
  articleLikeOnly: true,
  excludePdf: true,
  sameOriginOnly: true
};

export function evaluateLinkCandidate(
  candidate: LinkCandidate,
  pageUrl: string,
  filters: LinkFilterOptions
): LinkEvaluation {
  const reasons: string[] = [];
  const url = new URL(candidate.url);
  const pageOrigin = new URL(pageUrl).origin;
  const label = candidate.title.trim();
  let score = 0;

  if (filters.sameOriginOnly && url.origin !== pageOrigin) {
    reasons.push("cross-origin");
  } else if (url.origin === pageOrigin) {
    score += 1;
  }

  if (isPdfLike(candidate)) {
    reasons.push("pdf");
    score -= 8;
  }

  if (isStaticAssetUrl(candidate.url)) {
    reasons.push("static-asset");
    score -= 8;
  }

  if (label.length >= 8 && label.length <= 120) {
    score += 2;
  } else if (label.length < 8) {
    score -= 2;
  }

  if (hasArticleLikeUrl(url)) {
    score += 3;
  }

  if (hasDateSignal(url)) {
    score += 2;
  }

  if (filters.excludePdf && reasons.includes("pdf")) {
    return { excluded: true, reasons, score };
  }

  const excluded =
    reasons.includes("cross-origin") ||
    reasons.includes("static-asset") ||
    (filters.articleLikeOnly && score < ARTICLE_THRESHOLD);

  return {
    excluded,
    reasons,
    score
  };
}

export function isPdfLike(candidate: LinkCandidate): boolean {
  const label = candidate.title.trim().toLowerCase();
  const url = candidate.url.toLowerCase();

  return label === "pdf" || url.includes(".pdf") || url.includes("keypdf=") || url.includes("pdf");
}

export function isStaticAssetUrl(url: string): boolean {
  return STATIC_ASSET_EXTENSIONS.test(url);
}

function hasArticleLikeUrl(url: URL): boolean {
  const value = `${url.pathname} ${url.search}`.toLowerCase();

  return (
    /\/(article|articles|post|posts|entry|entries|story|stories|news|columns?)\b/.test(value) ||
    /\b(article|entry|post|story|contents?|detail)\b/.test(value) ||
    /[?&](articleid|article_id|id|newsid|contentsid|pageid)=/.test(value) ||
    /\/\d{4}\/\d{1,2}\/\d{1,2}\//.test(value) ||
    /\d{8,}/.test(value) ||
    /\.do(\?|$)/.test(value)
  );
}

function hasDateSignal(url: URL): boolean {
  const value = `${url.pathname} ${url.search}`.toLowerCase();

  return (
    /[?&](date|from|to|publish|published|ymd)=\d{6,8}/.test(value) ||
    /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/.test(value) ||
    /\b20\d{6}\b/.test(value)
  );
}
