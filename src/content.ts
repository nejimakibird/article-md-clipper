import { exportMarkdownFilename, markdownFilename } from "./lib/filename";
import { DEFAULT_LINK_FILTERS, evaluateLinkCandidate, isStaticAssetUrl } from "./lib/linkFilters";
import { escapeYamlString, extractArticleMarkdown, pageToMarkdown } from "./lib/markdown";
import type {
  ClipResponse,
  ContentRequestMessage,
  ContentResponse,
  DownloadMarkdownMessage,
  ExportSelectedLinksResponse,
  FailJobMessage,
  FinishJobMessage,
  FindLinksResponse,
  GeneratedMarkdownResponse,
  LinkFilterOptions,
  LinkCandidate,
  OpenPreviewMessage,
  OutputMetadata,
  OutputMode,
  PageSnapshot,
  PreviewProgress,
  PreviewResponse
} from "./types";

const DEFAULT_MAX_LINK_CANDIDATES = 50;
const DEFAULT_EXPORT_DELAY_MS = 1000;
const DEFAULT_MAX_SELECTED_LINKS = 10;

chrome.runtime.onMessage.addListener(
  (
    message: ContentRequestMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ContentResponse) => void
  ) => {
    if (message.type === "CLIP_CURRENT_PAGE") {
      clipCurrentPage()
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "Could not clip the current page."
          });
        });

      return true;
    }

    if (message.type === "FIND_LINKS") {
      try {
        sendResponse(
          findLinksOnCurrentPage(
            message.payload?.maxCandidates ?? DEFAULT_MAX_LINK_CANDIDATES,
            resolveLinkFilters(message.payload?.filters, message.payload?.sameOriginOnly)
          )
        );
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Could not find links on this page."
        });
      }

      return false;
    }

    if (message.type === "EXPORT_SELECTED_LINKS") {
      exportSelectedLinks(
        message.payload.links,
        message.payload.sourceUrl,
        message.payload.maxSelected ?? DEFAULT_MAX_SELECTED_LINKS,
        message.payload.delayMs ?? DEFAULT_EXPORT_DELAY_MS,
        message.payload.outputMode ?? "download"
      )
        .then(sendResponse)
        .catch((error: unknown) => {
          const statusMessage =
            error instanceof Error ? error.message : "Could not export selected links.";
          sendResponse({
            ok: false,
            error: statusMessage
          });
        });

      return true;
    }

    return false;
  }
);

async function clipCurrentPage(): Promise<GeneratedMarkdownResponse> {
  const snapshot: PageSnapshot = {
    html: document.documentElement.outerHTML,
    title: document.title,
    url: location.href
  };

  const { markdown, title } = pageToMarkdown(snapshot);
  const filename = markdownFilename(title);
  const capturedAtMatch = markdown.match(/^captured_at:\s*"([^"]+)"/m);

  return {
    ok: true,
    filename,
    markdown,
    metadata: {
      articleCount: 1,
      capturedAt: capturedAtMatch?.[1] ?? new Date().toISOString(),
      sourceUrl: snapshot.url,
      title
    }
  };
}

function findLinksOnCurrentPage(
  maxCandidates: number,
  filters: LinkFilterOptions
): FindLinksResponse {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const seenUrls = new Set<string>();
  const filteredCandidates: LinkCandidate[] = [];

  for (const anchor of anchors) {
    const normalizedUrl = normalizeCandidateUrl(anchor);

    if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
      continue;
    }

    seenUrls.add(normalizedUrl);
    const candidate: LinkCandidate = {
      title: linkDisplayText(anchor, normalizedUrl),
      url: normalizedUrl
    };
    const evaluation = evaluateLinkCandidate(candidate, location.href, filters);

    if (!evaluation.excluded) {
      filteredCandidates.push({
        ...candidate,
        score: evaluation.score
      });
    }
  }

  const sortedCandidates = filteredCandidates
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, maxCandidates);

  return {
    ok: true,
    candidatesAfterFilters: filteredCandidates.length,
    totalLinksFound: anchors.length,
    candidatesShown: sortedCandidates.length,
    candidates: sortedCandidates
  };
}

function normalizeCandidateUrl(anchor: HTMLAnchorElement): string | null {
  const rawHref = anchor.getAttribute("href")?.trim();

  if (!rawHref || rawHref.startsWith("#")) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(rawHref, location.href);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return null;
  }

  url.hash = "";
  return isStaticAssetUrl(url.href) ? null : url.href;
}

function resolveLinkFilters(
  filters: Partial<LinkFilterOptions> | undefined,
  legacySameOriginOnly: boolean | undefined
): LinkFilterOptions {
  return {
    ...DEFAULT_LINK_FILTERS,
    ...filters,
    sameOriginOnly: filters?.sameOriginOnly ?? legacySameOriginOnly ?? DEFAULT_LINK_FILTERS.sameOriginOnly
  };
}

function linkDisplayText(anchor: HTMLAnchorElement, url: string): string {
  const imgAlt = anchor.querySelector("img")?.getAttribute("alt");
  const candidates = [
    findTitleLikeText(anchor),
    anchor.getAttribute("aria-label"),
    anchor.getAttribute("title"),
    imgAlt,
    getReadableAnchorText(anchor),
    urlPathLabel(url),
    url
  ];

  for (const candidate of candidates) {
    const label = normalizeCandidateLabel(candidate ?? "");

    if (label) {
      return label;
    }
  }

  return url;
}

async function exportSelectedLinks(
  links: LinkCandidate[],
  sourceUrl: string,
  maxSelected: number,
  delayMs: number,
  outputMode: OutputMode
): Promise<ExportSelectedLinksResponse> {
  const capturedAt = new Date();
  const results: ExportArticleResult[] = [];
  let savedCount = 0;
  let failedCount = 0;
  let filename = exportMarkdownFilename(capturedAt);
  let markdown = "";
  let metadata: OutputMetadata | undefined;
  let finalStatus = "";
  let generatedMarkdown = false;
  let progressivePreviewId: string | null = null;

  try {
    if (links.length === 0) {
      throw new Error("Select at least one link first.");
    }

    if (links.length > maxSelected) {
      throw new Error(`Select up to ${maxSelected} links.`);
    }

    metadata = {
      articleCount: 0,
      capturedAt: capturedAt.toISOString(),
      sourceUrl,
      title: "Article Markdown Clipper Export"
    };

    if (outputMode === "preview") {
      markdown = buildCombinedMarkdown(results, sourceUrl, capturedAt);
      progressivePreviewId = await openProgressivePreview(markdown, filename, metadata, {
        completed: 0,
        failed: 0,
        isRunning: true,
        statusMessage: `Loading articles: 0 / ${links.length}, failed: 0`,
        total: links.length
      });
    }

    for (const [index, link] of links.entries()) {
      await updateExportJobState({
        completed: index,
        failed: results.filter((result) => !result.ok).length,
        statusMessage: `Processing ${index + 1} / ${links.length}`,
        total: links.length
      });
      const result = await fetchAndConvertArticle(link);
      results.push(result);
      const currentSavedCount = results.filter((item) => item.ok).length;
      const currentFailedCount = results.length - currentSavedCount;
      metadata = {
        articleCount: currentSavedCount,
        capturedAt: capturedAt.toISOString(),
        sourceUrl,
        title: "Article Markdown Clipper Export"
      };
      markdown = buildCombinedMarkdown(results, sourceUrl, capturedAt);

      if (progressivePreviewId) {
        await updateProgressivePreview(progressivePreviewId, markdown, metadata, {
          completed: index + 1,
          currentTitle: result.ok ? result.title : undefined,
          currentUrl: result.sourceUrl,
          failed: currentFailedCount,
          isRunning: true,
          statusMessage: `Loading articles: ${index + 1} / ${links.length}, failed: ${currentFailedCount}`,
          total: links.length
        });
      }

      await updateExportJobState({
        completed: index + 1,
        failed: results.filter((result) => !result.ok).length,
        statusMessage: `Processing ${index + 1} / ${links.length}`,
        total: links.length
      });

      if (index < links.length - 1) {
        await delay(delayMs);
      }
    }

    savedCount = results.filter((result) => result.ok).length;
    failedCount = results.length - savedCount;
    metadata = {
      articleCount: savedCount,
      capturedAt: capturedAt.toISOString(),
      sourceUrl,
      title: "Article Markdown Clipper Export"
    };
    generatedMarkdown = true;

    await updateExportJobState({
      completed: links.length,
      failed: failedCount,
      statusMessage: "Preparing output...",
      total: links.length
    });

    let outputMessage = "Opened Markdown preview.";

    if (progressivePreviewId) {
      await updateProgressivePreview(progressivePreviewId, markdown, metadata, {
        completed: links.length,
        failed: failedCount,
        isRunning: false,
        statusMessage: `Complete. Saved ${savedCount} articles, ${failedCount} failed.`,
        total: links.length
      });
    } else {
      outputMessage = await outputGeneratedMarkdown(markdown, filename, outputMode, metadata);
    }

    finalStatus = [`Saved ${savedCount} articles, ${failedCount} failed.`, outputMessage]
      .filter(Boolean)
      .join(" ");

    return {
      ok: true,
      failedCount,
      filename,
      markdown,
      metadata,
      savedCount
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not export selected links.";
    finalStatus = generatedMarkdown
      ? `Saved ${savedCount} articles, ${failedCount} failed. Output failed: ${message}`
      : message;

    return {
      ok: false,
      error: finalStatus
    };
  } finally {
    if (generatedMarkdown) {
      await finishExportJob(finalStatus || `Saved ${savedCount} articles, ${failedCount} failed.`, savedCount, failedCount);
    } else {
      await failExportJob(finalStatus || "Could not export selected links.", failedCount);
    }
  }
}

async function openProgressivePreview(
  markdown: string,
  filename: string,
  metadata: OutputMetadata,
  progress: PreviewProgress
): Promise<string | null> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "OPEN_PREVIEW",
      payload: {
        filename,
        markdown,
        metadata,
        progress
      }
    } satisfies OpenPreviewMessage)) as PreviewResponse;

    if (!response?.ok) {
      throw new Error(response?.error || "Could not open Markdown preview.");
    }

    return response.previewId ?? null;
  } catch {
    return null;
  }
}

async function updateProgressivePreview(
  previewId: string,
  markdown: string,
  metadata: OutputMetadata,
  progress: PreviewProgress
): Promise<void> {
  await chrome.runtime
    .sendMessage({
      type: "UPDATE_PREVIEW_PAYLOAD",
      payload: {
        markdown,
        metadata,
        previewId,
        progress
      }
    })
    .catch(() => undefined);
}

type ExportArticleResult =
  | {
      ok: true;
      bodyMarkdown: string;
      capturedAt: string;
      sourceUrl: string;
      title: string;
    }
  | {
      ok: false;
      error: string;
      sourceUrl: string;
    };

async function fetchAndConvertArticle(link: LinkCandidate): Promise<ExportArticleResult> {
  try {
    const response = await fetch(link.url, {
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }

    const html = await response.text();
    const fetchedDocument = new DOMParser().parseFromString(html, "text/html");
    const { bodyMarkdown, title } = extractArticleMarkdown({
      html,
      title: fetchedDocument.title || link.title,
      url: link.url
    });

    return {
      ok: true,
      bodyMarkdown,
      capturedAt: new Date().toISOString(),
      sourceUrl: link.url,
      title
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to fetch article.",
      sourceUrl: link.url
    };
  }
}

function buildCombinedMarkdown(
  results: ExportArticleResult[],
  sourceUrl: string,
  capturedAt: Date
): string {
  const successfulResults = results.filter(
    (result): result is Extract<ExportArticleResult, { ok: true }> => result.ok
  );

  return [
    "---",
    'title: "Article Markdown Clipper Export"',
    `source: "${escapeYamlString(sourceUrl)}"`,
    `captured_at: "${capturedAt.toISOString()}"`,
    `article_count: ${successfulResults.length}`,
    "---",
    "",
    "# Article Markdown Clipper Export",
    "",
    ...results.flatMap((result, index) => articleResultToMarkdown(result, index + 1))
  ].join("\n");
}

function articleResultToMarkdown(result: ExportArticleResult, articleNumber: number): string[] {
  if (!result.ok) {
    return ["## Failed: " + result.sourceUrl, "", `- Error: ${result.error}`, "", "---", ""];
  }

  return [
    `## Article ${articleNumber}: ${result.title}`,
    "",
    `- Source: ${result.sourceUrl}`,
    `- Captured: ${result.capturedAt}`,
    "",
    normalizeArticleMarkdownForCombinedExport(result.bodyMarkdown, result.title),
    "",
    "---",
    ""
  ];
}

function normalizeArticleMarkdownForCombinedExport(markdown: string, articleTitle: string): string {
  const lines = markdown.split(/\r?\n/);
  const firstHeadingIndex = lines.findIndex((line) => line.trim() !== "");

  if (firstHeadingIndex >= 0 && isDuplicateTitleHeading(lines[firstHeadingIndex], articleTitle)) {
    lines.splice(firstHeadingIndex, 1);

    if (lines[firstHeadingIndex]?.trim() === "") {
      lines.splice(firstHeadingIndex, 1);
    }
  }

  let inFence = false;
  let fenceMarker = "";

  return lines
    .map((line) => {
      const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);

      if (fenceMatch) {
        const marker = fenceMatch[2][0];

        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (marker === fenceMarker) {
          inFence = false;
          fenceMarker = "";
        }

        return line;
      }

      if (inFence) {
        return line;
      }

      return line.replace(/^(#{1,6})(\s+.+)$/u, (_match, hashes: string, rest: string) => {
        const nextLevel = Math.min(hashes.length + 1, 6);
        return `${"#".repeat(nextLevel)}${rest}`;
      });
    })
    .join("\n")
    .trim();
}

function isDuplicateTitleHeading(line: string, articleTitle: string): boolean {
  const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/u);

  if (!match) {
    return false;
  }

  return normalizeHeadingText(match[1]) === normalizeHeadingText(articleTitle);
}

function normalizeHeadingText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function outputGeneratedMarkdown(
  markdown: string,
  filename: string,
  outputMode: OutputMode,
  metadata?: OutputMetadata
): Promise<string> {
  if (outputMode === "download") {
    await downloadGeneratedMarkdown(markdown, filename);
    return `Downloaded ${filename}`;
  }

  if (outputMode === "preview") {
    try {
      await openGeneratedPreview(markdown, filename, metadata);
      return "Opened Markdown preview.";
    } catch (error) {
      await downloadGeneratedMarkdown(markdown, filename);
      return `Preview failed (${errorMessage(error)}). Downloaded ${filename} instead.`;
    }
  }

  try {
    await navigator.clipboard.writeText(markdown);
    return "Copied Markdown to clipboard.";
  } catch (error) {
    try {
      await openGeneratedPreview(markdown, filename, metadata);
      return `Clipboard copy failed (${errorMessage(error)}). Opened preview instead.`;
    } catch {
      await downloadGeneratedMarkdown(markdown, filename);
      return `Clipboard copy failed (${errorMessage(error)}). Downloaded ${filename} instead.`;
    }
  }
}

async function downloadGeneratedMarkdown(markdown: string, filename: string): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: "DOWNLOAD_MARKDOWN",
    payload: {
      filename,
      markdown
    }
  } satisfies DownloadMarkdownMessage)) as ClipResponse;

  if (!response?.ok) {
    throw new Error(response?.error || "Could not download Markdown.");
  }
}

async function openGeneratedPreview(
  markdown: string,
  filename: string,
  metadata?: OutputMetadata
): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: "OPEN_PREVIEW",
    payload: {
      filename,
      markdown,
      metadata
    }
  } satisfies OpenPreviewMessage)) as PreviewResponse;

  if (!response?.ok) {
    throw new Error(response?.error || "Could not open Markdown preview.");
  }
}

async function updateExportJobState(
  payload: Partial<{
    completed: number;
    failed: number;
    statusMessage: string;
    total: number;
  }>
): Promise<void> {
  await chrome.runtime
    .sendMessage({
      type: "UPDATE_JOB_PROGRESS",
      payload
    })
    .catch(() => undefined);
}

async function finishExportJob(
  statusMessage: string,
  completed: number,
  failed: number
): Promise<void> {
  await chrome.runtime
    .sendMessage({
      type: "FINISH_JOB",
      payload: {
        completed,
        failed,
        statusMessage
      }
    } satisfies FinishJobMessage)
    .catch(() => undefined);
}

async function failExportJob(statusMessage: string, failed?: number): Promise<void> {
  await chrome.runtime
    .sendMessage({
      type: "FAIL_JOB",
      payload: {
        failed,
        statusMessage
      }
    } satisfies FailJobMessage)
    .catch(() => undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getReadableAnchorText(anchor: HTMLAnchorElement): string {
  const clone = anchor.cloneNode(true) as HTMLAnchorElement;

  clone
    .querySelectorAll("img, svg, picture, source, script, style, noscript, [aria-hidden='true']")
    .forEach((element) => {
      element.remove();
    });

  return firstMeaningfulTextChunk(clone.textContent ?? "");
}

function findTitleLikeText(anchor: HTMLAnchorElement): string {
  const heading = anchor.querySelector("h1, h2, h3, h4, h5, h6");

  if (heading?.textContent?.trim()) {
    return heading.textContent;
  }

  const titleLikeElement = Array.from(anchor.querySelectorAll<HTMLElement>("*")).find((element) =>
    hasTitleLikeClass(element)
  );

  return titleLikeElement?.textContent ?? "";
}

function hasTitleLikeClass(element: HTMLElement): boolean {
  const className = element.className?.toString().toLowerCase() ?? "";

  return (
    className.includes("title") ||
    className.includes("heading") ||
    className.includes("entry-title") ||
    className.includes("card-title") ||
    className.includes("post-title") ||
    className.includes("article-title")
  );
}

function normalizeCandidateLabel(value: string): string {
  const cleaned = value.replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();

  if (!cleaned || isHtmlLikeLabel(cleaned)) {
    return "";
  }

  if (cleaned.length <= 80) {
    return cleaned;
  }

  return `${cleaned.slice(0, 77).trimEnd()}...`;
}

function isHtmlLikeLabel(value: string): boolean {
  const lowerValue = value.toLowerCase();

  return (
    lowerValue.startsWith("<") ||
    lowerValue.includes("<img") ||
    lowerValue.includes("<svg") ||
    lowerValue.includes("src=") ||
    lowerValue.includes("class=") ||
    lowerValue.includes("width=") ||
    lowerValue.includes("height=") ||
    /<\/?[a-z][\s\S]*>/i.test(value) ||
    /&lt;\/?[a-z]/i.test(value)
  );
}

function urlPathLabel(url: string): string {
  try {
    const parsedUrl = new URL(url);
    const decodedPath = safeDecodeURIComponent(parsedUrl.pathname).replace(/\/+$/u, "");
    const slug = decodedPath.split("/").filter(Boolean).pop();

    if (!slug) {
      return parsedUrl.hostname || url;
    }

    return slug.replace(/[-_]+/g, " ");
  } catch {
    return url;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function firstMeaningfulTextChunk(value: string): string {
  const withoutZeroWidth = value.replace(/[\u200b-\u200d\ufeff]/g, "");
  const firstLine = withoutZeroWidth
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const text = firstLine || withoutZeroWidth.trim();
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentenceEnd = normalized.search(/[。.!?！？]/u);

  if (sentenceEnd >= 12 && sentenceEnd <= 80) {
    return normalized.slice(0, sentenceEnd + 1);
  }

  return normalized;
}
