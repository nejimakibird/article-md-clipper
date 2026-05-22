export type PageSnapshot = {
  html: string;
  title: string;
  url: string;
};

export type DownloadMarkdownMessage = {
  type: "DOWNLOAD_MARKDOWN";
  payload: {
    markdown: string;
    filename: string;
  };
};

export type OutputMode = "copy" | "download" | "preview";

export type OutputMetadata = {
  articleCount?: number;
  capturedAt?: string;
  sourceUrl?: string;
  title?: string;
};

export type PreviewProgress = {
  completed: number;
  currentTitle?: string;
  currentUrl?: string;
  failed: number;
  isRunning: boolean;
  statusMessage: string;
  total: number;
};

export type PreviewPayload = {
  createdAt: string;
  filename: string;
  markdown: string;
  metadata?: OutputMetadata;
  progress?: PreviewProgress;
  previewId: string;
};

export type OpenPreviewMessage = {
  type: "OPEN_PREVIEW";
  payload: {
    filename: string;
    markdown: string;
    metadata?: OutputMetadata;
    progress?: PreviewProgress;
  };
};

export type UpdatePreviewPayloadMessage = {
  type: "UPDATE_PREVIEW_PAYLOAD";
  payload: {
    markdown: string;
    metadata?: OutputMetadata;
    previewId: string;
    progress?: PreviewProgress;
  };
};

export type PreviewPayloadUpdatedMessage = {
  type: "PREVIEW_PAYLOAD_UPDATED";
  payload: {
    previewId: string;
  };
};

export type GetPreviewPayloadMessage = {
  type: "GET_PREVIEW_PAYLOAD";
  payload: {
    previewId: string;
  };
};

export type CleanupPreviewPayloadsMessage = {
  type: "CLEANUP_PREVIEW_PAYLOADS";
};

export type PreviewResponse =
  | {
      ok: true;
      payload?: PreviewPayload;
      previewId?: string;
      tabId?: number;
    }
  | {
      ok: false;
      error: string;
    };

export type OutputMessage =
  | CleanupPreviewPayloadsMessage
  | DownloadMarkdownMessage
  | GetPreviewPayloadMessage
  | OpenPreviewMessage
  | UpdatePreviewPayloadMessage;

export type JobType = "current-page" | "selected-links";

export type JobState = {
  completed: number;
  failed: number;
  isRunning: boolean;
  jobType: JobType | null;
  outputMode?: OutputMode | null;
  startedAt: string | null;
  statusMessage: string;
  total: number;
  updatedAt: string | null;
};

export type GetJobStateMessage = {
  type: "GET_JOB_STATE";
};

export type StartJobMessage = {
  type: "START_JOB";
  payload: {
    jobType: JobType;
    outputMode?: OutputMode | null;
    statusMessage?: string;
    total: number;
  };
};

export type UpdateJobStateMessage = {
  type: "UPDATE_JOB_STATE";
  payload: Partial<Pick<JobState, "completed" | "failed" | "statusMessage" | "total">>;
};

export type UpdateJobProgressMessage = {
  type: "UPDATE_JOB_PROGRESS";
  payload: Partial<Pick<JobState, "completed" | "failed" | "statusMessage" | "total">>;
};

export type FinishJobMessage = {
  type: "FINISH_JOB";
  payload: {
    completed?: number;
    failed?: number;
    statusMessage: string;
  };
};

export type FailJobMessage = {
  type: "FAIL_JOB";
  payload: {
    failed?: number;
    statusMessage: string;
  };
};

export type ResetJobStateMessage = {
  type: "RESET_JOB_STATE";
};

export type JobControlMessage =
  | FailJobMessage
  | FinishJobMessage
  | GetJobStateMessage
  | ResetJobStateMessage
  | StartJobMessage
  | UpdateJobProgressMessage
  | UpdateJobStateMessage;

export type StartJobResponse =
  | {
      ok: true;
      state: JobState;
    }
  | {
      ok: false;
      error: string;
      state: JobState;
    };

export type ClipResponse =
  | {
      ok: true;
      downloadId: number;
      filename: string;
    }
  | {
      ok: false;
      error: string;
    };

export type GeneratedMarkdownResponse =
  | {
      ok: true;
      filename: string;
      markdown: string;
      metadata?: OutputMetadata;
    }
  | {
      ok: false;
      error: string;
    };

export type LinkCandidate = {
  score?: number;
  title: string;
  url: string;
};

export type LinkFilterOptions = {
  articleLikeOnly: boolean;
  excludePdf: boolean;
  sameOriginOnly: boolean;
};

export type FindLinksRequestMessage = {
  type: "FIND_LINKS";
  payload?: {
    filters?: Partial<LinkFilterOptions>;
    maxCandidates?: number;
    sameOriginOnly?: boolean;
  };
};

export type FindLinksResponse =
  | {
      ok: true;
      candidatesAfterFilters: number;
      totalLinksFound: number;
      candidatesShown: number;
      candidates: LinkCandidate[];
    }
  | {
      ok: false;
      error: string;
    };

export type ExportSelectedLinksRequestMessage = {
  type: "EXPORT_SELECTED_LINKS";
  payload: {
    delayMs?: number;
    links: LinkCandidate[];
    maxSelected?: number;
    outputMode?: OutputMode;
    sourceUrl: string;
  };
};

export type ExportSelectedLinksResponse =
  | {
      ok: true;
      failedCount: number;
      filename: string;
      markdown: string;
      metadata?: OutputMetadata;
      savedCount: number;
    }
  | {
      ok: false;
      error: string;
    };

export type ExportProgressMessage = {
  type: "EXPORT_PROGRESS";
  payload: {
    current: number;
    total: number;
  };
};

export type ClipCurrentPageRequestMessage = {
  type: "CLIP_CURRENT_PAGE";
};

export type ContentRequestMessage =
  | ClipCurrentPageRequestMessage
  | ExportSelectedLinksRequestMessage
  | FindLinksRequestMessage;

export type ContentResponse = ExportSelectedLinksResponse | FindLinksResponse | GeneratedMarkdownResponse;
