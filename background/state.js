// Per-window tree state: parent relationships + collapsed nodes.
// Tabs themselves are never duplicated here — chrome.tabs is the source of
// truth for existence/order/title/etc. We only persist the *structure* that
// Chrome doesn't know about.

const parentsByWindow = new Map(); // windowId -> Map<tabId, parentId|null>
const collapsedByWindow = new Map(); // windowId -> Set<tabId>

function storageKey(windowId) {
  return `tree:${windowId}`;
}

export async function loadWindowState(windowId) {
  if (parentsByWindow.has(windowId)) return;
  const key = storageKey(windowId);
  const stored = await chrome.storage.session.get(key);
  const data = stored[key] || { parents: {}, collapsed: [] };
  parentsByWindow.set(
    windowId,
    new Map(Object.entries(data.parents).map(([k, v]) => [Number(k), v]))
  );
  collapsedByWindow.set(windowId, new Set(data.collapsed));
}

export async function persistWindowState(windowId) {
  const parents = parentsByWindow.get(windowId) || new Map();
  const collapsed = collapsedByWindow.get(windowId) || new Set();
  const key = storageKey(windowId);
  await chrome.storage.session.set({
    [key]: {
      parents: Object.fromEntries(parents),
      collapsed: [...collapsed],
    },
  });
}

export function getParentMap(windowId) {
  if (!parentsByWindow.has(windowId)) parentsByWindow.set(windowId, new Map());
  return parentsByWindow.get(windowId);
}

export function getCollapsedSet(windowId) {
  if (!collapsedByWindow.has(windowId)) collapsedByWindow.set(windowId, new Set());
  return collapsedByWindow.get(windowId);
}

export function setParent(windowId, tabId, parentId) {
  const parents = getParentMap(windowId);
  if (parentId === null || parentId === undefined) {
    parents.delete(tabId);
  } else {
    parents.set(tabId, parentId);
  }
}

export function removeTab(windowId, tabId) {
  const parents = getParentMap(windowId);
  const parentId = parents.has(tabId) ? parents.get(tabId) : null;
  // Promote children to grandparent so the subtree doesn't vanish.
  for (const [childId, pId] of parents.entries()) {
    if (pId === tabId) parents.set(childId, parentId);
  }
  parents.delete(tabId);
  getCollapsedSet(windowId).delete(tabId);
}

export function toggleCollapsed(windowId, tabId) {
  const set = getCollapsedSet(windowId);
  if (set.has(tabId)) set.delete(tabId);
  else set.add(tabId);
}

export function isDescendant(windowId, candidateId, ancestorId) {
  const parents = getParentMap(windowId);
  let cur = candidateId;
  const seen = new Set();
  while (parents.has(cur)) {
    cur = parents.get(cur);
    if (cur === ancestorId) return true;
    if (seen.has(cur)) break; // cycle guard
    seen.add(cur);
  }
  return false;
}

export function clearWindow(windowId) {
  parentsByWindow.delete(windowId);
  collapsedByWindow.delete(windowId);
  chrome.storage.session.remove(storageKey(windowId));
}
