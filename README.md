# Page Reader for Obsidian

Read long notes and clipped articles in a paged, Apple Books-style reader.

## Features

- Opens any Markdown note in a dedicated Page Reader view
- Swipe left/right on touch devices to turn pages
- Trackpad horizontal swipes, arrow keys, Page Up/Down, Space/Shift+Space
- Previous/Next controls and progress bar
- Remembers the page for each note and resumes there later
- Reflows pages when the pane is resized or reader settings change
- Optional themes: Obsidian, Paper, Sepia, Night

## Usage

1. Open a long Markdown note.
2. Run **Open active note in Page Reader** from the command palette, click the ribbon book icon, or right-click a Markdown file and choose **Open in Page Reader**.
3. Turn pages with swipes, horizontal trackpad gestures, arrow keys, or the footer buttons.
4. Close the reader whenever you want; your page is saved automatically.
5. Run **Resume last Page Reader note** to jump back to your last article.

## Settings

Settings → Page Reader includes font size, line height, page padding, page gap, reader theme, justified text, frontmatter hiding, new-tab behavior, and whether vertical mouse-wheel scrolling should turn pages.

## Manual installation

Copy these files into `.obsidian/plugins/page-reader/` in your vault:

- `manifest.json`
- `main.js`
- `styles.css`

Then enable **Page Reader** in Settings → Community plugins.

## Development

```bash
npm install
npm run build
```

For development watching:

```bash
npm run dev
```
