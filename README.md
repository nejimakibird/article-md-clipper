# Article Markdown Clipper

A small Chrome/Edge Manifest V3 extension that saves the readable content of the current page as a Markdown file.

## What it does

- Opens a popup with actions for saving the current page and discovering links.
- Collects the current tab's HTML, title, and URL only after you click the button.
- Uses Mozilla Readability to extract article content.
- Converts the extracted HTML to Markdown with Turndown.
- Falls back to converting `document.body.innerHTML` when Readability cannot extract an article.
- Downloads a `.md` file with front matter metadata.
- Can output Markdown by downloading, copying to the clipboard, or opening a plain-text preview tab.
- Finds candidate same-origin article links on the current page and shows them with checkboxes.
- Saves explicitly selected candidate links into one combined Markdown export.

## Setup

```bash
npm install
```

## Build

```bash
npm run build
```

The loadable extension is written to `dist/`.

For rebuilds while editing:

```bash
npm run dev
```

## Load in Chrome or Edge

1. Run `npm run build`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select this project's `dist/` folder.

## Use

1. Open a normal `http` or `https` article page.
2. Click the Article Markdown Clipper extension icon.
3. Click Save current page as Markdown.
4. Confirm a `.md` file downloads.

To discover links without fetching them, click Find links on this page. V0.2 lists up to 50 same-origin candidate links from the current document and lets you select them with checkboxes.

To export linked articles, select up to 10 discovered links and click Save selected links as Markdown. V0.3 fetches the selected links one by one, waits 1000 ms between requests, and outputs one combined Markdown file according to the selected Output mode.

Preview is implemented as a tab first. The payload/loading logic is reusable for a future side panel.

If a development build ever shows a stuck running export, use the popup's Reset stuck job button. You can also clear the persisted job state from the extension service worker console:

```js
chrome.storage.local.remove("articleMarkdownClipperJobState");
```

The Markdown starts with:

```markdown
---
title: "Page title"
source: "https://example.com/article"
captured_at: "2026-05-12T00:00:00.000Z"
---

# Page title

Markdown body...
```

## Known limitations

- V0.1 clips only the current page.
- V0.2 discovers links without fetching linked pages.
- V0.3 fetches only links explicitly selected in the popup.
- No recursive crawling, site-specific rules, authentication handling beyond browser-session credentials, cloud upload, summarization, or external API calls.
- Downloads use a `data:` URL for simplicity; very large pages may hit browser URL-size limits.
- Preview payloads are stored temporarily in extension storage and old payloads are cleaned up after about 1 hour.
- Running export job state has stale recovery; if progress has not updated for about 5 minutes, controls are unlocked on the next background startup or job-state check.
- Some pages block script injection, including browser internal pages and some extension stores.

## Privacy

Article Markdown Clipper processes page content locally in the browser.

It does not send page content or personal data to any external server.

See [Privacy Policy](./PRIVACY.md).
