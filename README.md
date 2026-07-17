# Tree Style Tabs

A vertical, nestable tab tree for Chrome, in the spirit of Firefox's Tree
Style Tab — built as a side panel extension (Manifest V3).

## Features

- **Nesting** — tabs opened from a link automatically become children of the
  tab they came from.
- **Collapse / expand** — click the chevron to fold a whole subtree; a badge
  shows how many tabs are hidden inside.
- **Drag and drop** — drop on the top/bottom edge of a tab to reorder it as a
  sibling, or in the middle to nest it as a child. Dropping on empty space
  un-nests a tab back to the root.
- **Native tab group integration** — Chrome tab groups render as colored
  section headers.
- **Quick filter** — press `/` to search titles/URLs; matches (and their
  ancestors) stay visible while everything else dims out.
- **Keyboard navigation** — arrow keys to move focus, `Enter` to switch tabs,
  `←`/`→` to collapse/expand, `Backspace`/`Delete` to close (hold `Shift` to
  close a tab's children too).
- **Mute/unmute** and **new child tab** actions inline on hover.
- Boxed, angular tab rows — sharp clipped corners instead of rounded ones.

## Loading it in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Click the extension's toolbar icon to open the side panel.

## Structure

- `manifest.json` — MV3 manifest (side panel + tabs/tabGroups/storage
  permissions).
- `background/background.js` — service worker: owns tab-tree state, listens
  to `chrome.tabs`/`chrome.tabGroups` events, and pushes live snapshots to
  the side panel over a long-lived port.
- `background/state.js` — the tree data model (parent map + collapsed set),
  persisted per-window in `chrome.storage.session`.
- `sidepanel/` — the panel UI: renders the tree, handles drag/drop, filtering,
  and keyboard navigation.

Only the parent/child structure and collapsed state are persisted by the
extension itself; tab existence, order, titles, and favicons always come
live from the `chrome.tabs` API, so the tree can't drift out of sync with
your actual tabs.
