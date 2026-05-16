import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { PageSnapshot } from "../types";

type MarkdownResult = {
  markdown: string;
  title: string;
  usedReadability: boolean;
};

const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  headingStyle: "atx"
});

turndown.addRule("removeEmptyLinks", {
  filter: (node) => node.nodeName === "A" && normalizeText(node.textContent) === "",
  replacement: () => ""
});

export function pageToMarkdown(snapshot: PageSnapshot, capturedAt = new Date()): MarkdownResult {
  const { bodyMarkdown, title, usedReadability } = extractArticleMarkdown(snapshot);

  return {
    title,
    usedReadability,
    markdown: [
      "---",
      `title: "${escapeYamlString(title)}"`,
      `source: "${escapeYamlString(snapshot.url)}"`,
      `captured_at: "${capturedAt.toISOString()}"`,
      "---",
      "",
      `# ${title}`,
      "",
      bodyMarkdown
    ].join("\n")
  };
}

export function escapeYamlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export type ExtractedArticleMarkdown = {
  bodyMarkdown: string;
  title: string;
  usedReadability: boolean;
};

export function extractArticleMarkdown(snapshot: PageSnapshot): ExtractedArticleMarkdown {
  const parsedDocument = new DOMParser().parseFromString(snapshot.html, "text/html");
  const article = new Readability(parsedDocument).parse();

  const title = article?.title?.trim() || snapshot.title.trim() || "Untitled";
  const readableHtml = article?.content?.trim();
  const fallbackHtml = parsedDocument.body?.innerHTML?.trim() || snapshot.html;
  const cleanedHtml = cleanArticleHtmlBeforeMarkdown(readableHtml || fallbackHtml);

  return {
    bodyMarkdown: turndown.turndown(cleanedHtml).trim(),
    title,
    usedReadability: Boolean(readableHtml)
  };
}

export function cleanArticleHtmlBeforeMarkdown(html: string): string {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;

  removeHeadingChrome(wrapper);
  removeEmptyAnchors(wrapper);

  return wrapper.innerHTML;
}

function removeHeadingChrome(root: ParentNode): void {
  root.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((heading) => {
    const readableText = getReadableText(heading);

    heading.querySelectorAll("a").forEach((anchor) => {
      if (isEmptyAnchor(anchor) || (isHashLink(anchor) && getReadableText(anchor) === "")) {
        anchor.remove();
      }
    });

    heading.querySelectorAll('svg, [aria-hidden="true"]').forEach((element) => {
      element.remove();
    });

    if (readableText && !(heading.textContent?.trim() ?? "")) {
      heading.textContent = readableText;
    }
  });
}

function removeEmptyAnchors(root: ParentNode): void {
  root.querySelectorAll("a").forEach((anchor) => {
    if (isEmptyAnchor(anchor)) {
      anchor.remove();
    }
  });
}

function isEmptyAnchor(anchor: HTMLAnchorElement): boolean {
  return getReadableText(anchor) === "";
}

function isHashLink(anchor: HTMLAnchorElement): boolean {
  return anchor.getAttribute("href")?.startsWith("#") ?? false;
}

function getReadableText(element: Element): string {
  const clone = element.cloneNode(true) as Element;

  clone.querySelectorAll('svg, path, use, [aria-hidden="true"]').forEach((child) => {
    child.remove();
  });

  return normalizeText(clone.textContent);
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u200b-\u200d\ufeff]/g, "").trim();
}
