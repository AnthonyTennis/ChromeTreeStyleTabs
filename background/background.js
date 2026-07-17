import {
  loadWindowState,
  persistWindowState,
  getParentMap,
  getCollapsedSet,
  setParent,
  removeTab,
  toggleCollapsed,
  isDescendant,
  clearWindow,
} from "./state.js";

const ports = new Set(); // { port, windowId }
let broadcastTimer = null;
const dirtyWindows = new Set();

function scheduleBroadcast(windowId) {
  if (windowId != null) dirtyWindows.add(windowId);
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    const targets = dirtyWindows.size ? [...dirtyWindows] : [null];
    dirtyWindows.clear();
    for (const entry of ports) {
      if (targets.includes(null) || targets.includes(entry.windowId)) {
        try {
          await sendSnapshot(entry);
        } catch (e) {
          // port likely gone
        }
      }
    }
  }, 16);
}

async function sendSnapshot(entry) {
  if (entry.windowId == null) return;
  const snapshot = await buildSnapshot(entry.windowId);
  entry.port.postMessage({ type: "SNAPSHOT", snapshot });
}

async function buildSnapshot(windowId) {
  await loadWindowState(windowId);
  const parents = getParentMap(windowId);
  const collapsed = getCollapsedSet(windowId);

  const tabs = await chrome.tabs.query({ windowId });
  let groups = [];
  try {
    groups = await chrome.tabGroups.query({ windowId });
  } catch (e) {
    groups = [];
  }

  const byId = new Map(tabs.map((t) => [t.id, t]));
  const pinned = tabs
    .filter((t) => t.pinned)
    .sort((a, b) => a.index - b.index)
    .map((t) => ({
      id: t.id,
      title: t.title || t.url || "New Tab",
      url: t.url || t.pendingUrl || "",
      favIconUrl: t.favIconUrl || "",
      active: t.active,
      audible: !!t.audible,
      muted: !!(t.mutedInfo && t.mutedInfo.muted),
    }));

  const childrenOf = new Map();
  for (const t of tabs) {
    if (t.pinned) continue;
    let p = parents.has(t.id) ? parents.get(t.id) : null;
    if (p != null) {
      const pTab = byId.get(p);
      if (!pTab || pTab.pinned) p = null;
      else if (isDescendant(windowId, p, t.id)) p = null; // cycle guard
    }
    const key = p == null ? "root" : p;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(t.id);
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => byId.get(a).index - byId.get(b).index);
  }

  const nodes = [];
  let lastGroupId = -1;
  function visit(id, depth, parentId, hiddenByAncestor) {
    const tab = byId.get(id);
    const kids = childrenOf.get(id) || [];
    const collapsedHere = collapsed.has(id);
    const node = {
      id,
      parentId,
      depth,
      hidden: hiddenByAncestor,
      hasChildren: kids.length > 0,
      collapsed: collapsedHere,
      title: tab.title || tab.pendingUrl || tab.url || "New Tab",
      url: tab.url || tab.pendingUrl || "",
      favIconUrl: tab.favIconUrl || "",
      active: tab.active,
      audible: !!tab.audible,
      muted: !!(tab.mutedInfo && tab.mutedInfo.muted),
      status: tab.status,
      groupId: tab.groupId,
      index: tab.index,
      isGroupStart: false,
    };
    if (depth === 0) {
      if (tab.groupId != null && tab.groupId !== -1 && tab.groupId !== lastGroupId) {
        node.isGroupStart = true;
      }
      lastGroupId = tab.groupId != null ? tab.groupId : -1;
    }
    nodes.push(node);
    const childHidden = hiddenByAncestor || collapsedHere;
    for (const cid of kids) visit(cid, depth + 1, id, childHidden);
  }
  for (const rid of childrenOf.get("root") || []) visit(rid, 0, null, false);

  return {
    windowId,
    pinned,
    nodes,
    groups: groups.map((g) => ({
      id: g.id,
      title: g.title,
      color: g.color,
      collapsed: g.collapsed,
    })),
  };
}

async function subtreeIdsInDfsOrder(windowId, rootTabId) {
  const parents = getParentMap(windowId);
  const tabs = await chrome.tabs.query({ windowId });
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const childrenOf = new Map();
  for (const t of tabs) {
    const p = parents.has(t.id) ? parents.get(t.id) : null;
    const key = p == null ? "root" : p;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(t.id);
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => byId.get(a).index - byId.get(b).index);
  }
  const out = [];
  (function dfs(id) {
    out.push(id);
    for (const c of childrenOf.get(id) || []) dfs(c);
  })(rootTabId);
  return { out, byId };
}

async function reparentOne(windowId, tabId, newParentId, insertBeforeId) {
  if (newParentId === tabId) return;
  if (newParentId != null && isDescendant(windowId, newParentId, tabId)) return;

  setParent(windowId, tabId, newParentId ?? null);
  await persistWindowState(windowId);

  const { out: subtree, byId } = await subtreeIdsInDfsOrder(windowId, tabId);

  // insertBeforeId (computed client-side from the flat, depth-aware node
  // list) pins the exact drop position and always wins when present — it's
  // what makes reordering within a nested level land in the right spot
  // instead of always snapping to "first child of the parent."
  let targetIndex;
  if (insertBeforeId != null && byId.has(insertBeforeId) && !subtree.includes(insertBeforeId)) {
    targetIndex = byId.get(insertBeforeId).index;
  } else if (newParentId != null && byId.has(newParentId)) {
    targetIndex = byId.get(newParentId).index + 1;
  } else {
    targetIndex = -1;
  }

  try {
    await chrome.tabs.move(subtree, { index: targetIndex });
  } catch (e) {
    // ignore — e.g. moving across pinned boundary
  }
}

async function reparentTab(windowId, tabId, newParentId, insertBeforeId) {
  await reparentOne(windowId, tabId, newParentId, insertBeforeId);
  scheduleBroadcast(windowId);
}

// Moves an explicit multi-selection as a unit. Only "selection roots" — tabs
// whose current parent isn't also in the selection — are individually
// reparented; a selected tab whose parent is also selected simply rides
// along with that parent's subtree, exactly like a normal single-tab move.
// Roots are inserted in reverse so each one lands immediately before the
// previously-placed one, preserving the original relative order right
// before the target insertion point.
async function reparentMultiple(windowId, tabIds, newParentId, insertBeforeId) {
  const idSet = new Set(tabIds);
  const parents = getParentMap(windowId);
  const roots = tabIds.filter((id) => {
    const p = parents.has(id) ? parents.get(id) : null;
    return p == null || !idSet.has(p);
  });

  let cursor = insertBeforeId;
  for (const rootId of [...roots].reverse()) {
    await reparentOne(windowId, rootId, newParentId, cursor);
    cursor = rootId;
  }
  scheduleBroadcast(windowId);
}

async function closeTabAndMaybeChildren(windowId, tabId, closeChildren) {
  if (closeChildren) {
    const { out: subtree } = await subtreeIdsInDfsOrder(windowId, tabId);
    await chrome.tabs.remove(subtree);
  } else {
    await chrome.tabs.remove(tabId);
  }
}

async function closeMultiple(windowId, tabIds, closeChildren) {
  let idsToRemove;
  if (closeChildren) {
    const set = new Set();
    for (const id of tabIds) {
      const { out } = await subtreeIdsInDfsOrder(windowId, id);
      for (const x of out) set.add(x);
    }
    idsToRemove = [...set];
  } else {
    // Close exactly the tabs that were explicitly selected — no subtree
    // expansion — so a selected parent and a separately-selected child both
    // close, regardless of the parent/child relationship between them.
    idsToRemove = [...new Set(tabIds)];
  }
  try {
    await chrome.tabs.remove(idsToRemove);
  } catch (e) {
    // some ids may already be gone if subtrees overlapped
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  const entry = { port, windowId: null };
  ports.add(entry);

  port.onMessage.addListener(async (msg) => {
    try {
      switch (msg.type) {
        case "INIT": {
          entry.windowId = msg.windowId;
          await loadWindowState(msg.windowId);
          await sendSnapshot(entry);
          break;
        }
        case "ACTIVATE_TAB": {
          await chrome.tabs.update(msg.tabId, { active: true });
          break;
        }
        case "CLOSE_TAB": {
          await closeTabAndMaybeChildren(entry.windowId, msg.tabId, !!msg.closeChildren);
          break;
        }
        case "CLOSE_TABS": {
          await closeMultiple(entry.windowId, msg.tabIds, !!msg.closeChildren);
          break;
        }
        case "RELOAD_TAB": {
          await chrome.tabs.reload(msg.tabId);
          break;
        }
        case "RELOAD_TABS": {
          await Promise.all(msg.tabIds.map((id) => chrome.tabs.reload(id).catch(() => {})));
          break;
        }
        case "TOGGLE_COLLAPSE": {
          toggleCollapsed(entry.windowId, msg.tabId);
          await persistWindowState(entry.windowId);
          scheduleBroadcast(entry.windowId);
          break;
        }
        case "MOVE_NODE": {
          await reparentTab(entry.windowId, msg.tabId, msg.newParentId, msg.insertBeforeId);
          break;
        }
        case "MOVE_NODES": {
          await reparentMultiple(entry.windowId, msg.tabIds, msg.newParentId, msg.insertBeforeId);
          break;
        }
        case "NEW_CHILD_TAB": {
          const parentTab = await chrome.tabs.get(msg.parentId);
          const created = await chrome.tabs.create({
            windowId: entry.windowId,
            index: parentTab.index + 1,
            openerTabId: msg.parentId,
          });
          setParent(entry.windowId, created.id, msg.parentId);
          await persistWindowState(entry.windowId);
          break;
        }
        case "NEW_ROOT_TAB": {
          await chrome.tabs.create({ windowId: entry.windowId });
          break;
        }
        case "TOGGLE_MUTE": {
          const tab = await chrome.tabs.get(msg.tabId);
          await chrome.tabs.update(msg.tabId, { muted: !(tab.mutedInfo && tab.mutedInfo.muted) });
          break;
        }
      }
    } catch (e) {
      console.error("sidepanel message error", msg, e);
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(entry);
  });
});

// Chrome sets openerTabId even for tabs opened via ctrl+T / the new-tab
// button — pointing at whatever tab was active — so opener presence alone
// can't distinguish "spawned from this page" from "just a fresh blank tab."
// A blank tab lands on the New Tab Page, though, while a page-spawned tab
// always carries a real destination URL, so that's the signal we key on.
const BLANK_NEW_TAB_URLS = new Set(["chrome://newtab/", "chrome-search://local-ntp/local-ntp.html", "", undefined]);

function isBlankNewTab(tab) {
  return BLANK_NEW_TAB_URLS.has(tab.pendingUrl) && BLANK_NEW_TAB_URLS.has(tab.url);
}

chrome.tabs.onCreated.addListener(async (tab) => {
  await loadWindowState(tab.windowId);
  const opener = tab.openerTabId;
  if (opener != null && !isBlankNewTab(tab)) {
    try {
      const openerTab = await chrome.tabs.get(opener);
      if (openerTab.windowId === tab.windowId) {
        setParent(tab.windowId, tab.id, opener);
      }
    } catch (e) {
      // opener already gone
    }
  }
  await persistWindowState(tab.windowId);
  scheduleBroadcast(tab.windowId);
});

chrome.tabs.onRemoved.addListener(async (tabId, info) => {
  if (info.isWindowClosing) return;
  await loadWindowState(info.windowId);
  removeTab(info.windowId, tabId);
  await persistWindowState(info.windowId);
  scheduleBroadcast(info.windowId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  scheduleBroadcast(tab.windowId);
});

chrome.tabs.onActivated.addListener((info) => {
  scheduleBroadcast(info.windowId);
});

chrome.tabs.onMoved.addListener((tabId, info) => {
  scheduleBroadcast(info.windowId);
});

chrome.tabs.onAttached.addListener(async (tabId, info) => {
  await loadWindowState(info.newWindowId);
  scheduleBroadcast(info.newWindowId);
});

chrome.tabs.onDetached.addListener(async (tabId, info) => {
  removeTab(info.oldWindowId, tabId);
  await persistWindowState(info.oldWindowId);
  scheduleBroadcast(info.oldWindowId);
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const tab = await chrome.tabs.get(addedTabId).catch(() => null);
  if (!tab) return;
  await loadWindowState(tab.windowId);
  const parents = getParentMap(tab.windowId);
  if (parents.has(removedTabId)) {
    setParent(tab.windowId, addedTabId, parents.get(removedTabId));
    parents.delete(removedTabId);
  }
  for (const [childId, pId] of [...parents.entries()]) {
    if (pId === removedTabId) parents.set(childId, addedTabId);
  }
  await persistWindowState(tab.windowId);
  scheduleBroadcast(tab.windowId);
});

chrome.windows.onRemoved.addListener((windowId) => {
  clearWindow(windowId);
});

if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener((g) => scheduleBroadcast(g.windowId));
  chrome.tabGroups.onUpdated.addListener((g) => scheduleBroadcast(g.windowId));
  chrome.tabGroups.onRemoved.addListener((g) => scheduleBroadcast(g.windowId));
  chrome.tabGroups.onMoved.addListener((g) => scheduleBroadcast(g.windowId));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
