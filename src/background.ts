import type {
  ClipResponse,
  DownloadMarkdownMessage,
  GetPreviewPayloadMessage,
  JobControlMessage,
  JobState,
  OpenPreviewMessage,
  OutputMessage,
  PreviewPayload,
  PreviewPayloadUpdatedMessage,
  PreviewResponse,
  StartJobResponse,
  UpdatePreviewPayloadMessage
} from "./types";

const JOB_STATE_KEY = "articleMarkdownClipperJobState";
const PREVIEW_PAYLOAD_PREFIX = "articleMarkdownClipperPreview:";
const STALE_JOB_MS = 5 * 60 * 1000;
const STALE_PREVIEW_MS = 60 * 60 * 1000;

const IDLE_JOB_STATE: JobState = {
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

void getJobState().catch(() => undefined);

chrome.runtime.onMessage.addListener(
  (
    message: JobControlMessage | OutputMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ClipResponse | JobState | PreviewResponse | StartJobResponse) => void
  ) => {
    if (isPreviewPayloadUpdatedMessage(message)) {
      return false;
    }

    if (isOutputMessage(message)) {
      handleOutputMessage(message)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "Output action failed."
          });
        });

      return true;
    }

    handleJobMessage(message)
      .then(sendResponse)
      .catch(async (error: unknown) => {
        const state = await markJobFailed(
          error instanceof Error ? error.message : "Job state update failed."
        );
        sendResponse(state);
      });

    return true;
  }
);

function isPreviewPayloadUpdatedMessage(
  message: JobControlMessage | OutputMessage | PreviewPayloadUpdatedMessage
): message is PreviewPayloadUpdatedMessage {
  return message.type === "PREVIEW_PAYLOAD_UPDATED";
}

function isOutputMessage(message: JobControlMessage | OutputMessage): message is OutputMessage {
  return (
    message.type === "CLEANUP_PREVIEW_PAYLOADS" ||
    message.type === "DOWNLOAD_MARKDOWN" ||
    message.type === "GET_PREVIEW_PAYLOAD" ||
    message.type === "OPEN_PREVIEW" ||
    message.type === "UPDATE_PREVIEW_PAYLOAD"
  );
}

async function handleOutputMessage(message: OutputMessage): Promise<ClipResponse | PreviewResponse> {
  if (message.type === "DOWNLOAD_MARKDOWN") {
    return downloadMarkdown(message);
  }

  if (message.type === "OPEN_PREVIEW") {
    return openPreview(message);
  }

  if (message.type === "GET_PREVIEW_PAYLOAD") {
    return getPreviewPayload(message);
  }

  if (message.type === "UPDATE_PREVIEW_PAYLOAD") {
    return updatePreviewPayload(message);
  }

  await cleanupPreviewPayloads();
  return {
    ok: true
  };
}

async function downloadMarkdown(message: DownloadMarkdownMessage): Promise<ClipResponse> {
  const { filename, markdown } = message.payload;
  const url = markdownDataUrl(markdown);

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: "uniquify"
  });

  return {
    ok: true,
    downloadId,
    filename
  };
}

async function openPreview(message: OpenPreviewMessage): Promise<PreviewResponse> {
  await cleanupPreviewPayloads();

  const previewId = crypto.randomUUID();
  const payload: PreviewPayload = {
    createdAt: new Date().toISOString(),
    filename: message.payload.filename,
    markdown: message.payload.markdown,
    metadata: message.payload.metadata,
    progress: message.payload.progress,
    previewId
  };

  await chrome.storage.local.set({
    [previewStorageKey(previewId)]: payload
  });

  const tab = await chrome.tabs.create({
    active: true,
    url: chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(previewId)}`)
  });

  return {
    ok: true,
    previewId,
    tabId: tab.id
  };
}

async function updatePreviewPayload(message: UpdatePreviewPayloadMessage): Promise<PreviewResponse> {
  const key = previewStorageKey(message.payload.previewId);
  const stored = await chrome.storage.local.get(key);
  const currentPayload = stored[key] as PreviewPayload | undefined;

  if (!currentPayload) {
    return {
      ok: false,
      error: "Preview data was not found. Generate the Markdown again."
    };
  }

  const nextPayload: PreviewPayload = {
    ...currentPayload,
    markdown: message.payload.markdown,
    metadata: message.payload.metadata ?? currentPayload.metadata,
    progress: message.payload.progress ?? currentPayload.progress
  };

  await chrome.storage.local.set({
    [key]: nextPayload
  });

  void chrome.runtime
    .sendMessage({
      type: "PREVIEW_PAYLOAD_UPDATED",
      payload: {
        previewId: message.payload.previewId
      }
    })
    .catch(() => undefined);

  return {
    ok: true,
    payload: nextPayload,
    previewId: message.payload.previewId
  };
}

async function getPreviewPayload(message: GetPreviewPayloadMessage): Promise<PreviewResponse> {
  const stored = await chrome.storage.local.get(previewStorageKey(message.payload.previewId));
  const payload = stored[previewStorageKey(message.payload.previewId)] as PreviewPayload | undefined;

  if (!payload) {
    return {
      ok: false,
      error: "Preview data was not found. Generate the Markdown again."
    };
  }

  return {
    ok: true,
    payload
  };
}

async function cleanupPreviewPayloads(): Promise<void> {
  const stored = await chrome.storage.local.get(null);
  const staleKeys = Object.entries(stored)
    .filter(([key, value]) => key.startsWith(PREVIEW_PAYLOAD_PREFIX) && isStalePreviewPayload(value))
    .map(([key]) => key);

  if (staleKeys.length > 0) {
    await chrome.storage.local.remove(staleKeys);
  }
}

async function handleJobMessage(message: JobControlMessage): Promise<JobState | StartJobResponse> {
  if (message.type === "GET_JOB_STATE") {
    return getJobState();
  }

  if (message.type === "RESET_JOB_STATE") {
    return resetJobState("Stuck job state was reset.");
  }

  if (message.type === "START_JOB") {
    const currentState = await getJobState();

    if (currentState.isRunning) {
      return {
        ok: false,
        error: currentState.statusMessage || "An export is already running.",
        state: currentState
      };
    }

    const nextState: JobState = {
      completed: 0,
      failed: 0,
      isRunning: true,
      jobType: message.payload.jobType,
      outputMode: message.payload.outputMode ?? null,
      startedAt: new Date().toISOString(),
      statusMessage: message.payload.statusMessage || "Starting export...",
      total: message.payload.total,
      updatedAt: new Date().toISOString()
    };

    await saveJobState(nextState);
    return {
      ok: true,
      state: nextState
    };
  }

  if (message.type === "UPDATE_JOB_PROGRESS" || message.type === "UPDATE_JOB_STATE") {
    const currentState = await getJobState();
    const nextState: JobState = {
      ...currentState,
      ...message.payload,
      updatedAt: new Date().toISOString()
    };
    await saveJobState(nextState);
    return nextState;
  }

  if (message.type === "FINISH_JOB") {
    const currentState = await getJobState();
    const nextState: JobState = {
      ...currentState,
      completed: message.payload.completed ?? currentState.completed,
      failed: message.payload.failed ?? currentState.failed,
      isRunning: false,
      statusMessage: message.payload.statusMessage,
      updatedAt: new Date().toISOString()
    };
    await saveJobState(nextState);
    return nextState;
  }

  return markJobFailed(message.payload.statusMessage, message.payload.failed);
}

async function getJobState(): Promise<JobState> {
  const stored = await chrome.storage.local.get(JOB_STATE_KEY);
  const state = normalizeJobState(stored[JOB_STATE_KEY]);

  if (isStaleRunningJob(state)) {
    const staleState: JobState = {
      ...state,
      isRunning: false,
      statusMessage: "Previous export appears to have stopped. Controls have been re-enabled.",
      updatedAt: new Date().toISOString()
    };
    await saveJobState(staleState);
    return staleState;
  }

  return state;
}

async function markJobFailed(statusMessage: string, failed?: number): Promise<JobState> {
  const currentState = await getJobState();
  const nextState: JobState = {
    ...currentState,
    failed: failed ?? currentState.failed,
    isRunning: false,
    statusMessage,
    updatedAt: new Date().toISOString()
  };
  await saveJobState(nextState);
  return nextState;
}

async function saveJobState(state: JobState): Promise<void> {
  await chrome.storage.local.set({
    [JOB_STATE_KEY]: normalizeJobState(state)
  });
}

function isStaleRunningJob(state: JobState): boolean {
  if (!state.isRunning) {
    return false;
  }

  const timestamp = state.updatedAt || state.startedAt;

  if (!timestamp) {
    return true;
  }

  const parsedTimestamp = Date.parse(timestamp);

  if (!Number.isFinite(parsedTimestamp)) {
    return true;
  }

  return Date.now() - parsedTimestamp > STALE_JOB_MS;
}

async function resetJobState(statusMessage: string): Promise<JobState> {
  const state: JobState = {
    ...IDLE_JOB_STATE,
    statusMessage,
    updatedAt: new Date().toISOString()
  };
  await saveJobState(state);
  return state;
}

function markdownDataUrl(markdown: string): string {
  return `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`;
}

function normalizeJobState(value: unknown): JobState {
  if (!isRecord(value)) {
    return { ...IDLE_JOB_STATE };
  }

  return {
    completed: numberOrDefault(value.completed, IDLE_JOB_STATE.completed),
    failed: numberOrDefault(value.failed, IDLE_JOB_STATE.failed),
    isRunning: typeof value.isRunning === "boolean" ? value.isRunning : IDLE_JOB_STATE.isRunning,
    jobType: value.jobType === "current-page" || value.jobType === "selected-links" ? value.jobType : null,
    outputMode:
      value.outputMode === "copy" || value.outputMode === "download" || value.outputMode === "preview"
        ? value.outputMode
        : null,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    statusMessage: typeof value.statusMessage === "string" ? value.statusMessage : IDLE_JOB_STATE.statusMessage,
    total: numberOrDefault(value.total, IDLE_JOB_STATE.total),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null
  };
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function previewStorageKey(previewId: string): string {
  return `${PREVIEW_PAYLOAD_PREFIX}${previewId}`;
}

function isStalePreviewPayload(value: unknown): boolean {
  const createdAt = (value as Partial<PreviewPayload> | undefined)?.createdAt;

  if (!createdAt) {
    return false;
  }

  return Date.now() - Date.parse(createdAt) > STALE_PREVIEW_MS;
}
