import type {
  ClipCurrentPageRequestMessage,
  ExportSelectedLinksRequestMessage,
  ExportSelectedLinksResponse,
  FindLinksRequestMessage,
  FindLinksResponse,
  GeneratedMarkdownResponse,
  JobState,
  JobType,
  LinkFilterOptions,
  LinkCandidate,
  OutputMode,
  StartJobResponse
} from "../types";
import { outputMarkdown } from "../lib/output";

const saveButton = document.querySelector<HTMLButtonElement>("#saveButton");
const findLinksButton = document.querySelector<HTMLButtonElement>("#findLinksButton");
const saveSelectedButton = document.querySelector<HTMLButtonElement>("#saveSelectedButton");
const statusElement = document.querySelector<HTMLParagraphElement>("#status");
const linkResults = document.querySelector<HTMLElement>("#linkResults");
const totalLinksElement = document.querySelector<HTMLSpanElement>("#totalLinks");
const filteredLinksElement = document.querySelector<HTMLSpanElement>("#filteredLinks");
const candidatesShownElement = document.querySelector<HTMLSpanElement>("#candidatesShown");
const selectedCountElement = document.querySelector<HTMLSpanElement>("#selectedCount");
const estimatedDelayElement = document.querySelector<HTMLSpanElement>("#estimatedDelay");
const linkList = document.querySelector<HTMLFormElement>("#linkList");
const articleLikeOnlyInput = document.querySelector<HTMLInputElement>("#articleLikeOnly");
const excludePdfInput = document.querySelector<HTMLInputElement>("#excludePdf");
const sameOriginOnlyInput = document.querySelector<HTMLInputElement>("#sameOriginOnly");
const includeFilterInput = document.querySelector<HTMLInputElement>("#includeFilter");
const excludeFilterInput = document.querySelector<HTMLInputElement>("#excludeFilter");
const filterModeSelect = document.querySelector<HTMLSelectElement>("#filterMode");
const outputModeSelect = document.querySelector<HTMLSelectElement>("#outputMode");
const maxArticlesInput = document.querySelector<HTMLInputElement>("#maxArticlesInput");
const fetchDelaySelect = document.querySelector<HTMLSelectElement>("#fetchDelaySelect");
const selectTopShownButton = document.querySelector<HTMLButtonElement>("#selectTopShownButton");
const clearSelectionButton = document.querySelector<HTMLButtonElement>("#clearSelectionButton");
const resetJobButton = document.querySelector<HTMLButtonElement>("#resetJobButton");
const emptyLinkMessage = document.querySelector<HTMLParagraphElement>("#emptyLinkMessage");
const siteSettingsLabel = document.querySelector<HTMLDivElement>("#siteSettingsLabel");

const MAX_LINK_CANDIDATES = 50;
const DEFAULT_MAX_SELECTED_LINKS = 10;
const HARD_MAX_SELECTED_LINKS = 30;
const MIN_SELECTED_LINKS = 1;
const DEFAULT_FETCH_DELAY_MS = 1000;
const FETCH_DELAY_OPTIONS_MS = [0, 300, 500, 1000, 1500, 2000, 3000] as const;

let currentPageUrl = "";
let discoveredCandidates: LinkCandidate[] = [];
let visibleCandidates: LinkCandidate[] = [];
let selectedUrls = new Set<string>();
let lastTotalLinksFound = 0;
let lastCandidatesAfterFilters = 0;
let isBusy = false;
let jobState: JobState | null = null;
let jobPollTimer: number | null = null;
let currentSiteSettingsKey = "";
let currentHostSettingsKey = "";

type FilterMode = "plain" | "regex";

type SiteSettings = {
  articleLikeOnly: boolean;
  excludeFilter: string;
  excludePdf: boolean;
  fetchDelayMs: number;
  filterMode: FilterMode;
  includeFilter: string;
  maxArticles: number;
  outputMode: OutputMode;
  sameOriginOnly: boolean;
};

const DEFAULT_SITE_SETTINGS: SiteSettings = {
  articleLikeOnly: true,
  excludeFilter: "",
  excludePdf: true,
  fetchDelayMs: DEFAULT_FETCH_DELAY_MS,
  filterMode: "plain",
  includeFilter: "",
  maxArticles: DEFAULT_MAX_SELECTED_LINKS,
  outputMode: "download",
  sameOriginOnly: true
};

const DEFAULT_JOB_STATE: JobState = {
  completed: 0,
  failed: 0,
  isRunning: false,
  jobType: null,
  outputMode: null,
  startedAt: null,
  statusMessage: "",
  total: 0,
  updatedAt: null
};

saveButton?.addEventListener("click", () => {
  void saveCurrentPage();
});

findLinksButton?.addEventListener("click", () => {
  void findLinksOnPage();
});

saveSelectedButton?.addEventListener("click", () => {
  void saveSelectedLinks();
});

[articleLikeOnlyInput, excludePdfInput, sameOriginOnlyInput].forEach((input) => {
  input?.addEventListener("change", () => {
    void saveCurrentSiteSettings();
    void findLinksOnPage();
  });
});

[includeFilterInput, excludeFilterInput].forEach((input) => {
  input?.addEventListener("input", () => {
    void saveCurrentSiteSettings();
    renderVisibleLinkCandidates();
  });
});

filterModeSelect?.addEventListener("change", () => {
  updateFilterPlaceholders();
  void saveCurrentSiteSettings();
  renderVisibleLinkCandidates();
});

outputModeSelect?.addEventListener("change", () => {
  void saveCurrentSiteSettings();
});

maxArticlesInput?.addEventListener("change", () => {
  const maxSelected = currentMaxSelected();
  maxArticlesInput.value = String(maxSelected);
  void saveCurrentSiteSettings();
  trimSelectionToMax(maxSelected, true);
  renderVisibleLinkCandidates();
});

fetchDelaySelect?.addEventListener("change", () => {
  const fetchDelayMs = currentFetchDelayMs();
  fetchDelaySelect.value = String(fetchDelayMs);
  void saveCurrentSiteSettings();
  updateSelectedCount();
});

selectTopShownButton?.addEventListener("click", () => {
  const maxSelected = currentMaxSelected();
  selectedUrls = new Set(visibleCandidates.slice(0, maxSelected).map((candidate) => candidate.url));
  renderVisibleLinkCandidates();
  setStatus(`Selected ${selectedUrls.size} shown articles.`, "success");
});

clearSelectionButton?.addEventListener("click", () => {
  selectedUrls = new Set();
  renderVisibleLinkCandidates();
});

resetJobButton?.addEventListener("click", () => {
  void resetJobState();
});

void initializePopup();

async function saveCurrentPage(): Promise<void> {
  const outputMode = currentOutputMode();
  const startResponse = await startJob("current-page", 1, "Saving current page...", outputMode);

  if (!startResponse.ok) {
    applyJobState(startResponse.state);
    return;
  }

  setBusy(true);
  setStatus("Collecting page content...");

  try {
    const tab = await getActiveTab();

    if (!tab.id) {
      throw new Error("Could not find an active tab.");
    }

    setStatus("Converting to Markdown...");

    const contentResponse = await sendClipMessage(tab.id);

    if (!contentResponse?.ok) {
      throw new Error(contentResponse?.error || "Could not save the current page.");
    }

    const outputResult = await outputMarkdown(
      contentResponse.markdown,
      contentResponse.filename,
      outputMode,
      contentResponse.metadata
    );
    setStatus(outputResult.message, "success");
    await finishJob(outputResult.message, 1, 0);
  } catch (error) {
    const statusMessage = error instanceof Error ? error.message : "Something went wrong.";
    await failJob(statusMessage);
    setStatus(statusMessage, "error");
  } finally {
    setBusy(false);
    await refreshJobState();
  }
}

async function findLinksOnPage(): Promise<void> {
  const currentState = await refreshJobState();

  if (currentState.isRunning) {
    return;
  }

  setBusy(true);
  setStatus("Finding links...");

  try {
    const tab = await getActiveTab();

    if (!tab.id) {
      throw new Error("Could not find an active tab.");
    }

    currentPageUrl = tab.url ?? "";

    const response = await sendFindLinksMessage(tab.id);

    if (!response.ok) {
      throw new Error(response.error);
    }

    updateLinkCounters(response.totalLinksFound, response.candidatesAfterFilters, response.candidatesShown);
    renderLinkCandidates(response.candidates);
    setStatus(`Found ${response.candidatesShown} candidate links.`, "success");
  } catch (error) {
    renderLinkCandidates([]);
    updateLinkCounters(0, 0, 0);
    setStatus(error instanceof Error ? error.message : "Something went wrong.", "error");
  } finally {
    setBusy(false);
  }
}

async function saveSelectedLinks(): Promise<void> {
  const selectedLinks = getSelectedCandidates();
  const maxSelected = currentMaxSelected();

  if (selectedLinks.length === 0) {
    setStatus("Select at least one article.", "error");
    return;
  }

  if (selectedLinks.length > maxSelected) {
    trimSelectionToMax(maxSelected, false);
    setStatus(`Selection trimmed to ${maxSelected} articles.`, "error");
  }

  const linksToExport = getSelectedCandidates();
  const outputMode = currentOutputMode();
  const startResponse = await startJob(
    "selected-links",
    linksToExport.length,
    `Processing 0 / ${linksToExport.length}`,
    outputMode
  );

  if (!startResponse.ok) {
    applyJobState(startResponse.state);
    return;
  }

  setBusy(true);

  try {
    const response = await sendExportSelectedLinksMessage(linksToExport);

    if (!response.ok) {
      setStatus(response.error, "error");
      return;
    }

    const statusMessage = `Saved ${response.savedCount} articles, ${response.failedCount} failed.`;
    setStatus(statusMessage, "success");
  } catch (error) {
    const statusMessage = error instanceof Error ? error.message : "Something went wrong.";
    setStatus(statusMessage, "error");
  } finally {
    setBusy(false);
    await refreshJobState();
  }
}

async function sendClipMessage(tabId: number): Promise<GeneratedMarkdownResponse> {
  try {
    return (await chrome.tabs.sendMessage(tabId, {
      type: "CLIP_CURRENT_PAGE"
    } satisfies ClipCurrentPageRequestMessage)) as GeneratedMarkdownResponse;
  } catch (error) {
    throw new Error(
      `Could not reach the page content script. Reload the page and try again, or use a normal http/https page. ${
        error instanceof Error ? error.message : ""
      }`.trim()
    );
  }
}

async function sendFindLinksMessage(tabId: number): Promise<FindLinksResponse> {
  try {
    return (await chrome.tabs.sendMessage(tabId, {
      type: "FIND_LINKS",
      payload: {
        filters: currentLinkFilters(),
        maxCandidates: MAX_LINK_CANDIDATES,
        sameOriginOnly: sameOriginOnlyInput?.checked ?? true
      }
    } satisfies FindLinksRequestMessage)) as FindLinksResponse;
  } catch (error) {
    throw new Error(
      `Could not reach the page content script. Reload the page and try again, or use a normal http/https page. ${
        error instanceof Error ? error.message : ""
      }`.trim()
    );
  }
}

async function sendExportSelectedLinksMessage(
  links: LinkCandidate[]
): Promise<ExportSelectedLinksResponse> {
  const tab = await getActiveTab();

  if (!tab.id) {
    throw new Error("Could not find an active tab.");
  }

  try {
    return (await chrome.tabs.sendMessage(tab.id, {
      type: "EXPORT_SELECTED_LINKS",
      payload: {
        delayMs: currentFetchDelayMs(),
        links,
        maxSelected: currentMaxSelected(),
        outputMode: currentOutputMode(),
        sourceUrl: currentPageUrl || tab.url || ""
      }
    } satisfies ExportSelectedLinksRequestMessage)) as ExportSelectedLinksResponse;
  } catch (error) {
    throw new Error(
      `Could not reach the page content script. Reload the page and try again, or use a normal http/https page. ${
        error instanceof Error ? error.message : ""
      }`.trim()
    );
  }
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab) {
    throw new Error("No active tab found.");
  }

  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error("Open a normal web page before clipping.");
  }

  return tab;
}

function setBusy(nextIsBusy: boolean): void {
  isBusy = nextIsBusy;
  const shouldDisable = controlsLocked();
  if (saveButton) saveButton.disabled = shouldDisable;
  if (findLinksButton) findLinksButton.disabled = shouldDisable;
  if (articleLikeOnlyInput) articleLikeOnlyInput.disabled = shouldDisable;
  if (excludePdfInput) excludePdfInput.disabled = shouldDisable;
  if (sameOriginOnlyInput) sameOriginOnlyInput.disabled = shouldDisable;
  if (includeFilterInput) includeFilterInput.disabled = shouldDisable;
  if (excludeFilterInput) excludeFilterInput.disabled = shouldDisable;
  if (filterModeSelect) filterModeSelect.disabled = shouldDisable;
  if (outputModeSelect) outputModeSelect.disabled = shouldDisable;
  if (maxArticlesInput) maxArticlesInput.disabled = shouldDisable;
  if (fetchDelaySelect) fetchDelaySelect.disabled = shouldDisable;
  if (selectTopShownButton) selectTopShownButton.disabled = shouldDisable || visibleCandidates.length === 0;
  if (clearSelectionButton) clearSelectionButton.disabled = shouldDisable || selectedUrls.size === 0;
  if (resetJobButton) resetJobButton.disabled = isBusy;
  updateSaveSelectedButtonState();
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

function renderLinkCandidates(candidates: LinkCandidate[]): void {
  if (!linkResults || !linkList) {
    return;
  }

  discoveredCandidates = candidates;
  linkResults.hidden = candidates.length === 0;
  renderVisibleLinkCandidates();
}

function renderVisibleLinkCandidates(): void {
  if (!linkResults || !linkList) {
    return;
  }

  const textFilters = currentTextFilters();
  const matcher = createCandidateTextMatcher(textFilters);
  visibleCandidates = discoveredCandidates.filter((candidate) =>
    candidateMatchesTextFilters(candidate, matcher)
  );

  linkResults.hidden =
    discoveredCandidates.length === 0 && lastTotalLinksFound === 0 && lastCandidatesAfterFilters === 0;
  linkList.replaceChildren(
    ...visibleCandidates.map((candidate) => createLinkCandidateElement(candidate))
  );

  updateEmptyLinkMessage();
  updateLinkCounters(lastTotalLinksFound, lastCandidatesAfterFilters, visibleCandidates.length);
  updateSaveSelectedButtonState();
}

function createLinkCandidateElement(candidate: LinkCandidate): HTMLElement {
  const label = document.createElement("label");
  label.className = "link-item";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = candidate.url;
  checkbox.checked = selectedUrls.has(candidate.url);
  checkbox.disabled = !checkbox.checked && selectedUrls.size >= currentMaxSelected();
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      if (selectedUrls.size >= currentMaxSelected()) {
        checkbox.checked = false;
        setStatus(`Max ${currentMaxSelected()} articles selected.`, "error");
        updateSaveSelectedButtonState();
        return;
      }
      selectedUrls.add(candidate.url);
    } else {
      selectedUrls.delete(candidate.url);
    }
    updateSaveSelectedButtonState();
  });

  const text = document.createElement("span");
  text.className = "link-copy";

  const title = document.createElement("span");
  title.className = "link-title";
  title.textContent = candidate.title;

  const url = document.createElement("span");
  url.className = "link-url";
  url.textContent = candidate.url;

  text.append(title, url);
  label.append(checkbox, text);

  return label;
}

function updateLinkCounters(
  totalLinksFound: number,
  candidatesAfterFilters: number,
  candidatesShown: number
): void {
  lastTotalLinksFound = totalLinksFound;
  lastCandidatesAfterFilters = candidatesAfterFilters;

  if (linkResults) {
    linkResults.hidden = totalLinksFound === 0 && candidatesAfterFilters === 0 && candidatesShown === 0;
  }

  if (totalLinksElement) {
    totalLinksElement.textContent = `${totalLinksFound} links found`;
  }

  if (filteredLinksElement) {
    filteredLinksElement.textContent = `${candidatesAfterFilters} after filters`;
  }

  if (candidatesShownElement) {
    candidatesShownElement.textContent = `${candidatesShown} shown`;
  }

  updateSelectedCount();
}

function updateSaveSelectedButtonState(): void {
  if (!saveSelectedButton) {
    return;
  }

  const selectedCount = getSelectedCandidates().length;
  const maxSelected = currentMaxSelected();
  saveSelectedButton.disabled = controlsLocked() || selectedCount === 0;
  saveSelectedButton.textContent =
    selectedCount > 0
      ? `Save selected links as Markdown (${Math.min(selectedCount, maxSelected)})`
      : "Save selected links as Markdown";

  if (selectTopShownButton) {
    selectTopShownButton.disabled = controlsLocked() || visibleCandidates.length === 0;
    selectTopShownButton.textContent = `Select top ${maxSelected} shown`;
  }

  if (clearSelectionButton) {
    clearSelectionButton.disabled = controlsLocked() || selectedUrls.size === 0;
  }

  updateCheckboxDisabledStates();
  updateSelectedCount();
}

function getSelectedCandidates(): LinkCandidate[] {
  return discoveredCandidates.filter((candidate) => selectedUrls.has(candidate.url));
}

function currentLinkFilters(): LinkFilterOptions {
  return {
    articleLikeOnly: articleLikeOnlyInput?.checked ?? true,
    excludePdf: excludePdfInput?.checked ?? true,
    sameOriginOnly: sameOriginOnlyInput?.checked ?? true
  };
}

type TextFilters = {
  excludeFilter: string;
  includeFilter: string;
  mode: FilterMode;
};

type CandidateTextMatcher = {
  excludeMatcher: TextMatcher;
  includeMatcher: TextMatcher;
};

type TextMatcher = {
  error?: string;
  isActive: boolean;
  matches: (value: string) => boolean;
};

function currentTextFilters(): TextFilters {
  return {
    excludeFilter: excludeFilterInput?.value ?? "",
    includeFilter: includeFilterInput?.value ?? "",
    mode: currentFilterMode()
  };
}

function createCandidateTextMatcher(filters: TextFilters): CandidateTextMatcher {
  return {
    excludeMatcher: createTextMatcher(filters.excludeFilter, filters.mode, "exclude"),
    includeMatcher: createTextMatcher(filters.includeFilter, filters.mode, "include")
  };
}

function createTextMatcher(value: string, mode: FilterMode, label: "exclude" | "include"): TextMatcher {
  const filter = value.trim();

  if (!filter) {
    return {
      isActive: false,
      matches: () => false
    };
  }

  if (mode === "regex") {
    try {
      const regex = new RegExp(filter, "i");
      return {
        isActive: true,
        matches: (candidateText) => regex.test(candidateText)
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Invalid regular expression.";
      setStatus(`Invalid ${label} regex: ${errorMessage}`, "error");
      return {
        error: errorMessage,
        isActive: false,
        matches: () => false
      };
    }
  }

  const terms = filter
    .split(/[\s,]+/u)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);

  return {
    isActive: terms.length > 0,
    matches: (candidateText) => {
      const normalizedCandidateText = candidateText.toLowerCase();
      return terms.some((term) => normalizedCandidateText.includes(term));
    }
  };
}

function candidateMatchesTextFilters(
  candidate: LinkCandidate,
  matcher: CandidateTextMatcher
): boolean {
  const candidateText = `${candidate.title}\n${candidate.url}`;

  if (matcher.includeMatcher.isActive && !matcher.includeMatcher.matches(candidateText)) {
    return false;
  }

  if (matcher.excludeMatcher.isActive && matcher.excludeMatcher.matches(candidateText)) {
    return false;
  }

  return true;
}

function updateSelectedCount(): void {
  const selectedCount = getSelectedCandidates().length;

  if (selectedCountElement) {
    selectedCountElement.textContent = `${selectedCount} selected / max ${currentMaxSelected()}`;
  }

  if (estimatedDelayElement) {
    estimatedDelayElement.textContent = `Estimated delay wait: ${formatDelayWait(
      Math.max(0, selectedCount - 1) * currentFetchDelayMs()
    )}`;
  }
}

function updateEmptyLinkMessage(): void {
  if (!emptyLinkMessage) {
    return;
  }

  if (visibleCandidates.length > 0) {
    emptyLinkMessage.hidden = true;
    emptyLinkMessage.textContent = "";
    return;
  }

  if (lastCandidatesAfterFilters === 0 && lastTotalLinksFound > 0 && currentLinkFilters().articleLikeOnly) {
    emptyLinkMessage.hidden = false;
    emptyLinkMessage.textContent =
      "No article-like links found. Try turning off Article-like links only.";
    return;
  }

  if (discoveredCandidates.length > 0 && hasAnyTextFilter()) {
    emptyLinkMessage.hidden = false;
    emptyLinkMessage.textContent = "No links match the text filter.";
    return;
  }

  emptyLinkMessage.hidden = true;
  emptyLinkMessage.textContent = "";
}

function currentMaxSelected(): number {
  const rawValue = Number(maxArticlesInput?.value ?? DEFAULT_MAX_SELECTED_LINKS);
  const clampedValue = clampMaxArticles(rawValue);

  if (maxArticlesInput && maxArticlesInput.value !== String(clampedValue)) {
    maxArticlesInput.value = String(clampedValue);
  }

  return clampedValue;
}

function clampMaxArticles(value: number): number {
  return Math.min(
    HARD_MAX_SELECTED_LINKS,
    Math.max(MIN_SELECTED_LINKS, Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_SELECTED_LINKS)
  );
}

function currentFetchDelayMs(): number {
  const rawValue = Number(fetchDelaySelect?.value ?? DEFAULT_FETCH_DELAY_MS);
  const clampedValue = clampFetchDelayMs(rawValue);

  if (fetchDelaySelect && fetchDelaySelect.value !== String(clampedValue)) {
    fetchDelaySelect.value = String(clampedValue);
  }

  return clampedValue;
}

function clampFetchDelayMs(value: number): number {
  return FETCH_DELAY_OPTIONS_MS.includes(value as (typeof FETCH_DELAY_OPTIONS_MS)[number])
    ? value
    : DEFAULT_FETCH_DELAY_MS;
}

function formatDelayWait(delayMs: number): string {
  if (delayMs === 0) {
    return "0 sec";
  }

  if (delayMs % 1000 === 0) {
    return `${delayMs / 1000} sec`;
  }

  return `${(delayMs / 1000).toFixed(1)} sec`;
}

function currentFilterMode(): FilterMode {
  return filterModeSelect?.value === "regex" ? "regex" : "plain";
}

function currentOutputMode(): OutputMode {
  const value = outputModeSelect?.value;
  return value === "copy" || value === "preview" ? value : "download";
}

function updateFilterPlaceholders(): void {
  if (currentFilterMode() === "regex") {
    if (includeFilterInput) includeFilterInput.placeholder = "Include filter: economy|technology|AI";
    if (excludeFilterInput) excludeFilterInput.placeholder = "Exclude filter: Video|Watch|Live|Reel|Audio";
    return;
  }

  if (includeFilterInput) includeFilterInput.placeholder = "Include filter: keyword";
  if (excludeFilterInput) excludeFilterInput.placeholder = "Exclude filter: Video Watch Live";
}

function hasAnyTextFilter(): boolean {
  return Boolean((includeFilterInput?.value ?? "").trim() || (excludeFilterInput?.value ?? "").trim());
}

async function initializePopup(): Promise<void> {
  updateFilterPlaceholders();

  try {
    const tab = await getActiveTab();
    currentPageUrl = tab.url ?? "";
    currentSiteSettingsKey = tab.url ? getSettingsKeyFromUrl(tab.url) : "";
    currentHostSettingsKey = tab.url ? getHostSettingsKeyFromUrl(tab.url) : "";

    if (siteSettingsLabel) {
      siteSettingsLabel.textContent = currentSiteSettingsKey
        ? `Settings for: ${currentSiteSettingsKey}`
        : "Settings for: this site";
    }

    await loadCurrentSiteSettings();
    const state = await refreshJobState();
    if (state.isRunning) startJobPolling();
  } catch (error) {
    applySiteSettings(DEFAULT_SITE_SETTINGS);
    applyJobState(DEFAULT_JOB_STATE);
    setStatus(error instanceof Error ? error.message : "Popup initialized with default settings.", "error");
  }
}

async function loadCurrentSiteSettings(): Promise<void> {
  if (!currentSiteSettingsKey) {
    applySiteSettings(DEFAULT_SITE_SETTINGS);
    return;
  }

  const siteStorageKey = settingsStorageKey(currentSiteSettingsKey);
  const hostStorageKey = currentHostSettingsKey ? settingsStorageKey(currentHostSettingsKey) : "";
  const storageKeys = Array.from(new Set([siteStorageKey, hostStorageKey, "settingsByHost"].filter(Boolean)));
  const stored = (await chrome.storage.local.get(storageKeys)) as Record<
    string,
    Partial<SiteSettings> | Record<string, Partial<SiteSettings>> | undefined
  >;
  const legacySettingsByHost = stored.settingsByHost as Record<string, Partial<SiteSettings>> | undefined;
  const fallbackSettings =
    (stored[siteStorageKey] as Partial<SiteSettings> | undefined) ??
    (hostStorageKey ? (stored[hostStorageKey] as Partial<SiteSettings> | undefined) : undefined) ??
    legacySettingsByHost?.[currentHostSettingsKey];

  applySiteSettings({
    ...DEFAULT_SITE_SETTINGS,
    ...(fallbackSettings ?? {})
  });
}

async function saveCurrentSiteSettings(): Promise<void> {
  if (!currentSiteSettingsKey) {
    return;
  }

  await chrome.storage.local.set({
    [settingsStorageKey(currentSiteSettingsKey)]: currentSiteSettings()
  });
}

function applySiteSettings(settings: SiteSettings): void {
  if (articleLikeOnlyInput) articleLikeOnlyInput.checked = settings.articleLikeOnly;
  if (excludePdfInput) excludePdfInput.checked = settings.excludePdf;
  if (fetchDelaySelect) fetchDelaySelect.value = String(clampFetchDelayMs(settings.fetchDelayMs));
  if (sameOriginOnlyInput) sameOriginOnlyInput.checked = settings.sameOriginOnly;
  if (includeFilterInput) includeFilterInput.value = settings.includeFilter;
  if (excludeFilterInput) excludeFilterInput.value = settings.excludeFilter;
  if (filterModeSelect) filterModeSelect.value = settings.filterMode;
  if (outputModeSelect) outputModeSelect.value = settings.outputMode;
  if (maxArticlesInput) maxArticlesInput.value = String(clampMaxArticles(settings.maxArticles));
  updateFilterPlaceholders();
  renderVisibleLinkCandidates();
}

function currentSiteSettings(): SiteSettings {
  return {
    articleLikeOnly: articleLikeOnlyInput?.checked ?? DEFAULT_SITE_SETTINGS.articleLikeOnly,
    excludeFilter: excludeFilterInput?.value ?? "",
    excludePdf: excludePdfInput?.checked ?? DEFAULT_SITE_SETTINGS.excludePdf,
    fetchDelayMs: currentFetchDelayMs(),
    filterMode: currentFilterMode(),
    includeFilter: includeFilterInput?.value ?? "",
    maxArticles: currentMaxSelected(),
    outputMode: currentOutputMode(),
    sameOriginOnly: sameOriginOnlyInput?.checked ?? DEFAULT_SITE_SETTINGS.sameOriginOnly
  };
}

function settingsStorageKey(siteKey: string): string {
  return `siteSettings:${siteKey}`;
}

function getSettingsKeyFromUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    const host = normalizeHostname(url.hostname);
    const firstSegment = url.pathname.split("/").filter(Boolean)[0];

    return firstSegment ? `${host}/${firstSegment}` : host;
  } catch {
    return "";
  }
}

function getHostSettingsKeyFromUrl(urlString: string): string {
  try {
    return normalizeHostname(new URL(urlString).hostname);
  } catch {
    return "";
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function trimSelectionToMax(maxSelected: number, showStatus: boolean): void {
  const selectedCandidates = orderedSelectedCandidates();

  if (selectedCandidates.length <= maxSelected) {
    updateSaveSelectedButtonState();
    return;
  }

  selectedUrls = new Set(selectedCandidates.slice(0, maxSelected).map((candidate) => candidate.url));

  if (showStatus) {
    setStatus(`Selection reduced to ${maxSelected} articles.`, "success");
  }

  updateSaveSelectedButtonState();
}

function orderedSelectedCandidates(): LinkCandidate[] {
  const visibleUrls = new Set(visibleCandidates.map((candidate) => candidate.url));
  const visibleSelected = visibleCandidates.filter((candidate) => selectedUrls.has(candidate.url));
  const hiddenSelected = discoveredCandidates.filter(
    (candidate) => selectedUrls.has(candidate.url) && !visibleUrls.has(candidate.url)
  );

  return [...visibleSelected, ...hiddenSelected];
}

function updateCheckboxDisabledStates(): void {
  if (!linkList) {
    return;
  }

  const maxSelected = currentMaxSelected();
  const maxReached = getSelectedCandidates().length >= maxSelected;

  linkList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.disabled = controlsLocked() || (!checkbox.checked && maxReached);
  });
}

function controlsLocked(): boolean {
  return isBusy || Boolean(jobState?.isRunning);
}

async function startJob(
  jobType: JobType,
  total: number,
  statusMessage: string,
  outputMode: OutputMode = currentOutputMode()
): Promise<StartJobResponse> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "START_JOB",
      payload: {
        jobType,
        outputMode,
        statusMessage,
        total
      }
    })) as unknown;

    if (!isStartJobResponse(response)) {
      const state = safeErrorJobState("Could not start export. Job state response was invalid.");
      applyJobState(state);
      return {
        ok: false,
        error: state.statusMessage,
        state
      };
    }

    const state = normalizeJobState(response.state);
    applyJobState(state);

    return response.ok
      ? {
          ok: true,
          state
        }
      : {
          ok: false,
          error: typeof response.error === "string" ? response.error : "An export is already running.",
          state
        };
  } catch (error) {
    const state = safeErrorJobState(
      error instanceof Error ? `Could not start export: ${error.message}` : "Could not start export."
    );
    applyJobState(state);
    return {
      ok: false,
      error: state.statusMessage,
      state
    };
  }
}

async function finishJob(
  statusMessage: string,
  completed: number,
  failed: number
): Promise<JobState> {
  let state = safeFinishedJobState(statusMessage, completed, failed);

  try {
    state = normalizeJobState(
      await chrome.runtime.sendMessage({
        type: "FINISH_JOB",
        payload: {
          completed,
          failed,
          statusMessage
        }
      })
    );
  } catch {
    // Local state is enough to keep the popup usable if the service worker disappeared.
  }

  applyJobState(state);
  return state;
}

async function failJob(statusMessage: string): Promise<JobState> {
  let state = safeErrorJobState(statusMessage);

  try {
    state = normalizeJobState(
      await chrome.runtime.sendMessage({
        type: "FAIL_JOB",
        payload: {
          statusMessage
        }
      })
    );
  } catch {
    // Local state is enough to unlock controls and show the failure.
  }

  applyJobState(state);
  return state;
}

async function refreshJobState(): Promise<JobState> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "GET_JOB_STATE"
    })) as unknown;
    const state = normalizeJobState(extractJobStatePayload(response));

    applyJobState(state);
    return state;
  } catch {
    const state = safeErrorJobState("Job state unavailable. Controls have been re-enabled.");
    applyJobState(state);
    return state;
  }
}

function applyJobState(value: unknown): void {
  const state = normalizeJobState(value);
  const wasRunning = jobState?.isRunning ?? false;
  jobState = state;

  if (state.statusMessage) {
    setStatus(state.statusMessage, state.isRunning ? undefined : statusKindForCompletedJob(state));
  }

  if (resetJobButton) {
    resetJobButton.hidden = !state.isRunning;
  }

  if (state.isRunning) {
    startJobPolling();
  } else if (wasRunning) {
    stopJobPolling();
  }

  setBusy(isBusy);
}

function startJobPolling(): void {
  if (jobPollTimer !== null) {
    return;
  }

  jobPollTimer = window.setInterval(() => {
    void refreshJobState();
  }, 750);
}

function stopJobPolling(): void {
  if (jobPollTimer === null) {
    return;
  }

  window.clearInterval(jobPollTimer);
  jobPollTimer = null;
}

async function resetJobState(): Promise<void> {
  const state = normalizeJobState(
    await chrome.runtime
      .sendMessage({
        type: "RESET_JOB_STATE"
      })
      .catch(() => safeErrorJobState("Could not reset job state."))
  );
  applyJobState(state);
}

function normalizeJobState(value: unknown): JobState {
  if (!isRecord(value)) {
    return { ...DEFAULT_JOB_STATE };
  }

  return {
    completed: numberOrDefault(value.completed, DEFAULT_JOB_STATE.completed),
    failed: numberOrDefault(value.failed, DEFAULT_JOB_STATE.failed),
    isRunning: typeof value.isRunning === "boolean" ? value.isRunning : DEFAULT_JOB_STATE.isRunning,
    jobType: value.jobType === "current-page" || value.jobType === "selected-links" ? value.jobType : null,
    outputMode:
      value.outputMode === "copy" || value.outputMode === "download" || value.outputMode === "preview"
        ? value.outputMode
        : null,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    statusMessage:
      typeof value.statusMessage === "string" ? value.statusMessage : DEFAULT_JOB_STATE.statusMessage,
    total: numberOrDefault(value.total, DEFAULT_JOB_STATE.total),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null
  };
}

function extractJobStatePayload(response: unknown): unknown {
  if (isRecord(response) && "state" in response) {
    return response.state;
  }

  return response;
}

function isStartJobResponse(value: unknown): value is StartJobResponse {
  return isRecord(value) && typeof value.ok === "boolean" && isRecord(value.state);
}

function safeErrorJobState(statusMessage: string): JobState {
  return {
    ...DEFAULT_JOB_STATE,
    statusMessage,
    updatedAt: new Date().toISOString()
  };
}

function safeFinishedJobState(statusMessage: string, completed: number, failed: number): JobState {
  return {
    ...DEFAULT_JOB_STATE,
    completed,
    failed,
    statusMessage,
    total: completed + failed,
    updatedAt: new Date().toISOString()
  };
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusKindForCompletedJob(state: JobState): "success" | "error" | undefined {
  const normalizedMessage = state.statusMessage.toLowerCase();

  if (
    normalizedMessage.includes("could not") ||
    normalizedMessage.includes("error") ||
    normalizedMessage.includes("failed") ||
    normalizedMessage.includes("invalid") ||
    normalizedMessage.includes("stopped") ||
    normalizedMessage.includes("unavailable")
  ) {
    return "error";
  }

  return state.statusMessage ? "success" : undefined;
}
