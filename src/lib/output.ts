import type { ClipResponse, OutputMetadata, OutputMode, PreviewResponse } from "../types";

export type OutputResult = {
  message: string;
  mode: OutputMode;
};

export async function downloadMarkdown(markdown: string, filename: string): Promise<OutputResult> {
  const response = (await chrome.runtime.sendMessage({
    type: "DOWNLOAD_MARKDOWN",
    payload: {
      markdown,
      filename
    }
  })) as ClipResponse;

  if (!response?.ok) {
    throw new Error(response?.error || "Could not download the Markdown file.");
  }

  return {
    message: `Downloaded ${response.filename}`,
    mode: "download"
  };
}

export async function copyMarkdownToClipboard(markdown: string): Promise<OutputResult> {
  await navigator.clipboard.writeText(markdown);

  return {
    message: "Copied Markdown to clipboard.",
    mode: "copy"
  };
}

export async function previewMarkdown(
  markdown: string,
  filename: string,
  metadata?: OutputMetadata
): Promise<OutputResult> {
  const response = (await chrome.runtime.sendMessage({
    type: "OPEN_PREVIEW",
    payload: {
      filename,
      markdown,
      metadata
    }
  })) as PreviewResponse;

  if (!response?.ok) {
    throw new Error(response?.error || "Could not open Markdown preview.");
  }

  return {
    message: "Opened Markdown preview.",
    mode: "preview"
  };
}

export async function outputMarkdown(
  markdown: string,
  filename: string,
  mode: OutputMode,
  metadata?: OutputMetadata
): Promise<OutputResult> {
  if (mode === "download") {
    return downloadMarkdown(markdown, filename);
  }

  if (mode === "preview") {
    try {
      return await previewMarkdown(markdown, filename, metadata);
    } catch {
      const result = await downloadMarkdown(markdown, filename);
      return {
        ...result,
        message: "Preview could not open. Downloaded Markdown instead."
      };
    }
  }

  try {
    return await copyMarkdownToClipboard(markdown);
  } catch {
    const result = await previewMarkdown(markdown, filename, metadata);
    return {
      ...result,
      message: "Clipboard copy failed. Opened preview instead."
    };
  }
}
