import DOMPurify from "dompurify";
import { marked } from "marked";
import { downloadMarkdown } from "../lib/output";
import type { PreviewPayload, PreviewPayloadUpdatedMessage, PreviewResponse } from "../types";

const previewPage = document.querySelector<HTMLElement>("#previewPage");
const statusElement = document.querySelector<HTMLParagraphElement>("#status");
const filenameElement = document.querySelector<HTMLElement>("#filename");
const characterCountElement = document.querySelector<HTMLElement>("#characterCount");
const articleCountElement = document.querySelector<HTMLElement>("#articleCount");
const generatedAtElement = document.querySelector<HTMLElement>("#generatedAt");
const sourceUrlElement = document.querySelector<HTMLElement>("#sourceUrl");
const progressCountElement = document.querySelector<HTMLElement>("#progressCount");
const progressFailedElement = document.querySelector<HTMLElement>("#progressFailed");
const progressCurrentElement = document.querySelector<HTMLElement>("#progressCurrent");
const previewDetails = document.querySelector<HTMLElement>("#previewDetails");
const previewContent = document.querySelector<HTMLElement>("#previewContent");
const markdownText = document.querySelector<HTMLTextAreaElement>("#markdownText");
const renderedMarkdown = document.querySelector<HTMLElement>("#renderedMarkdown");
const renderWarning = document.querySelector<HTMLParagraphElement>("#renderWarning");
const copyButton = document.querySelector<HTMLButtonElement>("#copyButton");
const downloadButton = document.querySelector<HTMLButtonElement>("#downloadButton");
const detailsToggleButton = document.querySelector<HTMLButtonElement>("#detailsToggleButton");
const plainTextViewButton = document.querySelector<HTMLButtonElement>("#plainTextViewButton");
const renderedViewButton = document.querySelector<HTMLButtonElement>("#renderedViewButton");
const splitViewButton = document.querySelector<HTMLButtonElement>("#splitViewButton");
const autoUpdatePreviewInput = document.querySelector<HTMLInputElement>("#autoUpdatePreview");
const updatePreviewButton = document.querySelector<HTMLButtonElement>("#updatePreviewButton");
const modifiedStatus = document.querySelector<HTMLElement>("#modifiedStatus");

const NARROW_VIEWPORT_QUERY = "(max-width: 640px)";
const LARGE_MARKDOWN_RENDER_WARNING_CHARS = 100_000;
const LIVE_PREVIEW_MAX_CHARS = 50_000;
const PROGRESSIVE_RENDER_INTERVAL_MS = 500;

type ViewMode = "plain" | "rendered" | "split";

let previewPayload: PreviewPayload | null = null;
let renderedHtmlCache: string | null = null;
let debounceTimer: number | null = null;
let currentMarkdown = "";
let isModified = false;
let isRendering = false;
let renderAgainAfterCurrent = false;
let detailsExpanded = true;
let currentViewMode: ViewMode = "rendered";
let currentPreviewId = "";
let progressPollTimer: number | null = null;
let progressiveRenderTimer: number | null = null;
let lastProgressiveRenderStartedAt = 0;

const narrowViewportMedia = window.matchMedia(NARROW_VIEWPORT_QUERY);

copyButton?.addEventListener("click", () => {
  void copyMarkdown();
});

downloadButton?.addEventListener("click", () => {
  void downloadPreviewMarkdown();
});

plainTextViewButton?.addEventListener("click", () => {
  setViewMode("plain");
});

renderedViewButton?.addEventListener("click", () => {
  void setViewMode("rendered");
});

splitViewButton?.addEventListener("click", () => {
  void setViewMode("split");
});

detailsToggleButton?.addEventListener("click", () => {
  setDetailsExpanded(!detailsExpanded);
});

markdownText?.addEventListener("input", () => {
  handleMarkdownInput();
});

autoUpdatePreviewInput?.addEventListener("change", () => {
  updatePreviewButtonState();

  if (autoUpdatePreviewInput.checked) {
    scheduleRenderedPreviewUpdate();
  } else {
    clearRenderDebounceTimer();
  }
});

updatePreviewButton?.addEventListener("click", () => {
  clearRenderDebounceTimer();
  void updateRenderedPreview("manual");
});

narrowViewportMedia.addEventListener("change", () => {
  handleViewportModeConstraints();
});

chrome.runtime.onMessage.addListener((message: PreviewPayloadUpdatedMessage) => {
  if (message.type !== "PREVIEW_PAYLOAD_UPDATED" || message.payload.previewId !== currentPreviewId) {
    return false;
  }

  void refreshPreviewPayload();
  return false;
});

void initializePreview();

async function initializePreview(): Promise<void> {
  setDetailsExpanded(!isNarrowViewport());
  handleViewportModeConstraints();

  const previewId = new URLSearchParams(location.search).get("id");

  if (!previewId) {
    setStatus("Preview ID is missing.", "error");
    setControlsDisabled(true);
    return;
  }

  currentPreviewId = previewId;

  try {
    const response = await getPreviewPayload(previewId);

    if (!response.ok || !response.payload) {
      throw new Error(response.ok ? "Preview data was not found." : response.error);
    }

    previewPayload = response.payload;
    await renderPreview(response.payload, true);
    if (!response.payload.progress) {
      setStatus("Preview ready.", "success");
    }
    setControlsDisabled(false);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not load preview.", "error");
    setControlsDisabled(true);
  }
}

async function getPreviewPayload(previewId: string): Promise<PreviewResponse> {
  return (await chrome.runtime.sendMessage({
    type: "GET_PREVIEW_PAYLOAD",
    payload: {
      previewId
    }
  })) as PreviewResponse;
}

async function refreshPreviewPayload(): Promise<void> {
  if (!currentPreviewId) {
    return;
  }

  try {
    const response = await getPreviewPayload(currentPreviewId);

    if (!response.ok || !response.payload) {
      throw new Error(response.ok ? "Preview data was not found." : response.error);
    }

    previewPayload = response.payload;
    await renderPreview(response.payload, false);
    setControlsDisabled(false);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not update preview.", "error");
  }
}

async function renderPreview(payload: PreviewPayload, resetViewMode: boolean): Promise<void> {
  document.title = `${payload.filename} - Article Markdown Clipper Preview`;
  if (filenameElement) filenameElement.textContent = payload.filename;
  if (characterCountElement) characterCountElement.textContent = payload.markdown.length.toLocaleString();
  if (articleCountElement) articleCountElement.textContent = String(payload.metadata?.articleCount ?? "-");
  if (generatedAtElement) {
    generatedAtElement.textContent = payload.metadata?.capturedAt ?? payload.createdAt;
  }
  if (sourceUrlElement) sourceUrlElement.textContent = payload.metadata?.sourceUrl ?? "-";
  currentMarkdown = payload.markdown;
  isModified = false;
  if (markdownText) markdownText.value = currentMarkdown;
  if (autoUpdatePreviewInput && resetViewMode) {
    autoUpdatePreviewInput.checked = currentMarkdown.length < LIVE_PREVIEW_MAX_CHARS;
  }
  if (currentMarkdown.length >= LIVE_PREVIEW_MAX_CHARS) {
    setStatus("Large Markdown detected. Auto update is off by default.", undefined);
  }
  renderedHtmlCache = null;
  updateModifiedStatus();
  updatePreviewButtonState();
  updateProgressPolling(payload);
  setProgressStatus(payload);
  updateProgressDetails(payload);

  if (resetViewMode) {
    if (renderedMarkdown) renderedMarkdown.replaceChildren();
    await setViewMode("rendered");
  } else if (payload.progress?.isRunning) {
    if (currentViewMode !== "plain") {
      scheduleProgressiveRenderedPreviewUpdate();
    }
  } else {
    clearProgressiveRenderTimer();
    await updateRenderedPreview("progressive-final");
  }
}

async function setViewMode(mode: ViewMode): Promise<void> {
  if (!previewPayload || !markdownText || !renderedMarkdown) {
    return;
  }

  const nextMode = mode === "split" && isNarrowViewport() ? "rendered" : mode;
  currentViewMode = nextMode;
  setViewButtonState(nextMode);
  setPreviewContentMode(nextMode);

  if (renderWarning) {
    renderWarning.hidden = nextMode === "plain" || currentMarkdown.length < LARGE_MARKDOWN_RENDER_WARNING_CHARS;
  }

  if (nextMode !== "plain") {
    clearRenderDebounceTimer();
    clearProgressiveRenderTimer();
    await updateRenderedPreview("mode-switch");
  }
}

async function updateRenderedPreview(
  reason: "auto" | "manual" | "mode-switch" | "progressive" | "progressive-final"
): Promise<void> {
  if (!previewPayload || !renderedMarkdown) {
    return;
  }

  if (renderedHtmlCache !== null) {
    renderedMarkdown.innerHTML = renderedHtmlCache;
    return;
  }

  if (isRendering) {
    renderAgainAfterCurrent = true;
    return;
  }

  isRendering = true;
  updatePreviewButtonState();
  const shouldReportRenderStatus = reason === "auto" || reason === "manual" || reason === "mode-switch";

  try {
    if (shouldReportRenderStatus) {
      setStatus(reason === "auto" ? "Updating preview..." : "Rendering Markdown...", undefined);
    }
    const parsedHtml = await marked.parse(currentMarkdown, {
      async: false,
      gfm: true
    });
    renderedHtmlCache = DOMPurify.sanitize(parsedHtml);
    renderedMarkdown.innerHTML = renderedHtmlCache;
    lastProgressiveRenderStartedAt = Date.now();
    if (shouldReportRenderStatus) {
      setStatus(reason === "auto" ? "Rendered preview updated." : "Rendered preview ready.", "success");
    } else if (previewPayload?.progress) {
      setProgressStatus(previewPayload);
    }
  } catch (error) {
    setStatus(
      error instanceof Error ? `Could not update preview: ${error.message}` : "Could not update preview.",
      "error"
    );
  } finally {
    isRendering = false;
    updatePreviewButtonState();

    if (renderAgainAfterCurrent) {
      renderAgainAfterCurrent = false;
      if (previewPayload?.progress?.isRunning) {
        scheduleProgressiveRenderedPreviewUpdate();
      } else {
        scheduleRenderedPreviewUpdate();
      }
    }
  }
}

function setViewButtonState(mode: ViewMode): void {
  const buttons: Array<[HTMLButtonElement | null, ViewMode]> = [
    [renderedViewButton, "rendered"],
    [plainTextViewButton, "plain"],
    [splitViewButton, "split"]
  ];

  for (const [button, buttonMode] of buttons) {
    const isActive = mode === buttonMode;
    button?.classList.toggle("active", isActive);
    button?.setAttribute("aria-pressed", String(isActive));
  }
}

function setPreviewContentMode(mode: ViewMode): void {
  previewContent?.classList.toggle("mode-rendered", mode === "rendered");
  previewContent?.classList.toggle("mode-plain", mode === "plain");
  previewContent?.classList.toggle("mode-split", mode === "split");
}

function setDetailsExpanded(expanded: boolean): void {
  detailsExpanded = expanded;
  previewPage?.setAttribute("data-details-expanded", String(expanded));
  previewPage?.classList.toggle("details-expanded", expanded);
  previewPage?.classList.toggle("details-collapsed", !expanded);

  if (previewDetails) {
    previewDetails.hidden = !expanded;
    previewDetails.setAttribute("aria-hidden", String(!expanded));
  }

  if (detailsToggleButton) {
    detailsToggleButton.textContent = expanded ? "Hide details" : "Details";
    detailsToggleButton.setAttribute("aria-expanded", String(expanded));
  }
}

function isNarrowViewport(): boolean {
  return narrowViewportMedia.matches;
}

function handleViewportModeConstraints(): void {
  const isNarrow = isNarrowViewport();

  if (splitViewButton) {
    splitViewButton.hidden = isNarrow;
    splitViewButton.disabled = isNarrow;
    splitViewButton.setAttribute("aria-hidden", String(isNarrow));
  }

  if (isNarrow && currentViewMode === "split") {
    void setViewMode("rendered");
  }
}

function setProgressStatus(payload: PreviewPayload): void {
  if (!payload.progress) {
    return;
  }

  const { completed, failed, isRunning, total } = payload.progress;
  const compactMessage = isRunning
    ? `Loading ${completed} / ${total}`
    : failed > 0
      ? `Complete with ${failed} failed`
      : "Complete";
  setStatus(compactMessage, isRunning ? undefined : "success");
}

function updateProgressDetails(payload: PreviewPayload): void {
  const progress = payload.progress;

  if (!progress) {
    if (progressCountElement) progressCountElement.textContent = "-";
    if (progressFailedElement) progressFailedElement.textContent = "0";
    if (progressCurrentElement) progressCurrentElement.textContent = "-";
    return;
  }

  if (progressCountElement) {
    progressCountElement.textContent = `${progress.completed} / ${progress.total}`;
  }

  if (progressFailedElement) {
    progressFailedElement.textContent = String(progress.failed);
  }

  if (progressCurrentElement) {
    progressCurrentElement.textContent =
      progress.currentTitle || progress.currentUrl || progress.statusMessage || "-";
  }
}

function updateProgressPolling(payload: PreviewPayload): void {
  if (payload.progress?.isRunning) {
    if (progressPollTimer === null) {
      progressPollTimer = window.setInterval(() => {
        void refreshPreviewPayload();
      }, 1000);
    }
    return;
  }

  if (progressPollTimer !== null) {
    window.clearInterval(progressPollTimer);
    progressPollTimer = null;
  }
}

function scheduleProgressiveRenderedPreviewUpdate(): void {
  if (currentViewMode === "plain") {
    return;
  }

  if (progressiveRenderTimer !== null) {
    return;
  }

  const elapsedMs = Date.now() - lastProgressiveRenderStartedAt;
  const delayMs = Math.max(0, PROGRESSIVE_RENDER_INTERVAL_MS - elapsedMs);

  progressiveRenderTimer = window.setTimeout(() => {
    progressiveRenderTimer = null;
    void updateRenderedPreview("progressive");
  }, delayMs);
}

function clearProgressiveRenderTimer(): void {
  if (progressiveRenderTimer === null) {
    return;
  }

  window.clearTimeout(progressiveRenderTimer);
  progressiveRenderTimer = null;
}

async function copyMarkdown(): Promise<void> {
  if (!previewPayload) {
    return;
  }

  setControlsDisabled(true);

  try {
    await navigator.clipboard.writeText(currentMarkdown);
    setStatus("Copied Markdown to clipboard.", "success");
  } catch (error) {
    setStatus(
      error instanceof Error ? `Could not copy Markdown: ${error.message}` : "Could not copy Markdown.",
      "error"
    );
  } finally {
    setControlsDisabled(false);
  }
}

async function downloadPreviewMarkdown(): Promise<void> {
  if (!previewPayload) {
    return;
  }

  setControlsDisabled(true);

  try {
    await downloadMarkdown(currentMarkdown, previewPayload.filename);
    setStatus("Downloaded Markdown file.", "success");
  } catch (error) {
    setStatus(
      error instanceof Error ? `Could not download Markdown: ${error.message}` : "Could not download Markdown.",
      "error"
    );
  } finally {
    setControlsDisabled(false);
  }
}

function setStatus(message: string, kind?: "success" | "error"): void {
  if (!statusElement) {
    return;
  }

  statusElement.textContent = message;

  if (kind) {
    statusElement.dataset.kind = kind;
  } else {
    delete statusElement.dataset.kind;
  }
}

function setControlsDisabled(disabled: boolean): void {
  if (copyButton) copyButton.disabled = disabled;
  if (downloadButton) downloadButton.disabled = disabled;
  if (detailsToggleButton) detailsToggleButton.disabled = disabled;
  updatePreviewButtonState(disabled);
}

function handleMarkdownInput(): void {
  currentMarkdown = markdownText?.value ?? "";
  isModified = previewPayload?.markdown !== currentMarkdown;
  renderedHtmlCache = null;
  updateModifiedStatus();
  updatePreviewButtonState();

  if (autoUpdatePreviewInput?.checked) {
    scheduleRenderedPreviewUpdate();
  } else {
    setStatus("Preview is out of date. Use Update preview.", undefined);
  }
}

function scheduleRenderedPreviewUpdate(): void {
  clearRenderDebounceTimer();
  setStatus("Preview update scheduled...", undefined);

  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void updateRenderedPreview("auto");
  }, currentRenderDebounceMs());
}

function clearRenderDebounceTimer(): void {
  if (debounceTimer === null) {
    return;
  }

  window.clearTimeout(debounceTimer);
  debounceTimer = null;
}

function updateModifiedStatus(): void {
  if (modifiedStatus) {
    modifiedStatus.hidden = !isModified;
  }
}

function updatePreviewButtonState(forceDisabled = false): void {
  if (!updatePreviewButton) {
    return;
  }

  updatePreviewButton.disabled = forceDisabled || isRendering || renderedHtmlCache !== null;
}

function currentRenderDebounceMs(): number {
  if (currentMarkdown.length > 150_000) {
    return 3000;
  }

  if (currentMarkdown.length >= 50_000) {
    return 1500;
  }

  return 700;
}
