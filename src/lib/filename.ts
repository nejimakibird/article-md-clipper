const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function markdownFilename(title: string, fallback = "article"): string {
  const base =
    title
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 120)
      .trim() || fallback;

  const safeBase = RESERVED_WINDOWS_NAMES.test(base) ? `${base}-article` : base;
  return `${safeBase}.md`;
}

export function exportMarkdownFilename(capturedAt = new Date()): string {
  const timestamp = capturedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "")
    .replace("T", "-");

  return `article-md-export-${timestamp}.md`;
}
