const treeEl = document.getElementById("tree");
const pinnedRowEl = document.getElementById("pinnedRow");
const filterInput = document.getElementById("filterInput");
const newTabBtn = document.getElementById("newTabBtn");

let port = null;
let currentSnapshot = { pinned: [], nodes: [], groups: [] };
let filterText = "";
let keyboardFocusId = null;
let dragTabId = null;

function faviconUrl(pageUrl) {
  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.searchParams.set("pageUrl", pageUrl || "");
  url.searchParams.set("size", "32");
  return url.toString();
}

function svgChevron() {
  return `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1 L8 5 L2 9" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>`;
}
function svgClose() {
  return `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" stroke-width="1.5"/></svg>`;
}
function svgPlus() {
  return `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 1 V9 M1 5 H9" stroke="currentColor" stroke-width="1.5"/></svg>`;
}
function svgMute(muted) {
  return muted
    ? `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 3 H3 L6 1 V9 L3 7 H1 Z" fill="currentColor"/><path d="M7 3 L9.5 6.5 M9.5 3 L7 6.5" stroke="currentColor" stroke-width="1.2"/></svg>`
    : `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 3 H3 L6 1 V9 L3 7 H1 Z" fill="currentColor"/></svg>`;
}

function groupById(id) {
  return currentSnapshot.groups.find((g) => g.id === id);
}

function matchesFilter(node) {
  if (!filterText) return true;
  const hay = (node.title + " " + node.url).toLowerCase();
  return hay.includes(filterText);
}

function computeVisibility(nodes) {
  // When filtering, a node is shown if it matches, or if any descendant matches.
  if (!filterText) return nodes.map((n) => ({ ...n, filteredOut: false }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map();
  for (const n of nodes) {
    const key = n.parentId == null ? "root" : n.parentId;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(n.id);
  }
  const selfOrDescendantMatch = new Map();
  function computeMatch(id) {
    if (selfOrDescendantMatch.has(id)) return selfOrDescendantMatch.get(id);
    const n = byId.get(id);
    let match = matchesFilter(n);
    for (const cid of childrenOf.get(id) || []) {
      if (computeMatch(cid)) match = true;
    }
    selfOrDescendantMatch.set(id, match);
    return match;
  }
  for (const n of nodes) computeMatch(n.id);
  return nodes.map((n) => ({ ...n, filteredOut: !selfOrDescendantMatch.get(n.id) }));
}

function render(snapshot) {
  currentSnapshot = snapshot;

  pinnedRowEl.innerHTML = "";
  for (const t of snapshot.pinned) {
    const el = document.createElement("div");
    el.className = "pinned-tab" + (t.active ? " active" : "");
    el.title = t.title;
    el.innerHTML = `<img src="${faviconUrl(t.url)}" alt="" onerror="this.style.display='none'"/>`;
    el.addEventListener("click", () => send({ type: "ACTIVATE_TAB", tabId: t.id }));
    pinnedRowEl.appendChild(el);
  }

  const nodes = computeVisibility(snapshot.nodes);

  treeEl.innerHTML = "";

  if (nodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No tabs to show";
    treeEl.appendChild(empty);
    return;
  }

  let openGroupWrap = null;
  let openGroupId = null;

  for (const node of nodes) {
    if (node.depth === 0) {
      if (node.isGroupStart) {
        const g = groupById(node.groupId);
        const header = document.createElement("div");
        header.className = "group-header";
        if (g) header.style.setProperty("--group-color", cssColorForGroup(g.color));
        header.textContent = g ? g.title || "Group" : "Group";
        treeEl.appendChild(header);
        openGroupId = node.groupId;
      } else if (node.groupId == null || node.groupId === -1) {
        openGroupId = -1;
      }
    }
    treeEl.appendChild(renderNode(node));
  }

  if (keyboardFocusId != null) {
    const el = treeEl.querySelector(`[data-tab-id="${keyboardFocusId}"]`);
    if (el) el.classList.add("keyboard-focus");
  }
}

function cssColorForGroup(color) {
  const map = {
    grey: "#8a8d9a",
    blue: "#5b8cff",
    red: "#ff5b6e",
    yellow: "#e8c14a",
    green: "#4bd08b",
    pink: "#ff7ac6",
    purple: "#a17bff",
    cyan: "#4ad0d0",
    orange: "#ff9a4a",
  };
  return map[color] || "#5b8cff";
}

function renderNode(node) {
  const el = document.createElement("div");
  el.className = "node";
  el.dataset.tabId = node.id;
  el.style.setProperty("--depth", node.depth);
  el.draggable = true;
  if (node.active) el.classList.add("active");
  if (node.collapsed) el.classList.add("collapsed");
  if (node.filteredOut) el.classList.add("filtered-out");
  if (node.status === "loading") el.classList.add("loading");
  if (node.audible) el.classList.add("audible", "always-show");
  el.dataset.hidden = String(node.hidden && !filterText);

  const twisty = document.createElement("div");
  twisty.className = "twisty" + (node.hasChildren ? "" : " spacer");
  if (node.hasChildren) {
    twisty.innerHTML = svgChevron();
    twisty.addEventListener("click", (e) => {
      e.stopPropagation();
      send({ type: "TOGGLE_COLLAPSE", tabId: node.id });
    });
  }
  el.appendChild(twisty);

  const fav = document.createElement("div");
  fav.className = "favicon";
  const img = document.createElement("img");
  img.src = faviconUrl(node.url);
  img.alt = "";
  img.onerror = () => {
    fav.innerHTML = '<span class="fallback"></span>';
  };
  fav.appendChild(img);
  el.appendChild(fav);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = node.title;
  title.title = node.title + (node.url ? "\n" + node.url : "");
  el.appendChild(title);

  if (node.hasChildren && node.collapsed) {
    const count = document.createElement("div");
    count.className = "child-count";
    count.textContent = countDescendants(node.id);
    el.appendChild(count);
  }

  if (node.audible) {
    const muteBtn = document.createElement("button");
    muteBtn.className = "icon-btn mute";
    muteBtn.innerHTML = svgMute(node.muted);
    muteBtn.title = node.muted ? "Unmute tab" : "Mute tab";
    muteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      send({ type: "TOGGLE_MUTE", tabId: node.id });
    });
    el.appendChild(muteBtn);
  }

  const addBtn = document.createElement("button");
  addBtn.className = "icon-btn add";
  addBtn.innerHTML = svgPlus();
  addBtn.title = "New child tab";
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ type: "NEW_CHILD_TAB", parentId: node.id });
  });
  el.appendChild(addBtn);

  const closeBtn = document.createElement("button");
  closeBtn.className = "icon-btn close";
  closeBtn.innerHTML = svgClose();
  closeBtn.title = "Close tab";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ type: "CLOSE_TAB", tabId: node.id, closeChildren: e.shiftKey });
  });
  el.appendChild(closeBtn);

  el.addEventListener("click", () => {
    keyboardFocusId = node.id;
    send({ type: "ACTIVATE_TAB", tabId: node.id });
  });

  el.addEventListener("dragstart", (e) => {
    dragTabId = node.id;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(node.id));
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    dragTabId = null;
    clearDragMarkers();
  });
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (dragTabId == null || dragTabId === node.id) return;
    clearDragMarkers();
    const rect = el.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    if (ratio < 0.25) el.classList.add("drag-over-above");
    else if (ratio > 0.75) el.classList.add("drag-over-below");
    else el.classList.add("drag-over-child");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    if (dragTabId == null || dragTabId === node.id) return;
    const rect = el.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    let newParentId, beforeSiblingId;
    if (ratio < 0.25) {
      newParentId = node.parentId;
      beforeSiblingId = node.id;
    } else if (ratio > 0.75) {
      newParentId = node.parentId;
      beforeSiblingId = null;
    } else {
      newParentId = node.id;
      beforeSiblingId = null;
    }
    send({ type: "MOVE_NODE", tabId: dragTabId, newParentId, beforeSiblingId });
    clearDragMarkers();
  });

  return el;
}

function clearDragMarkers() {
  treeEl.querySelectorAll(".drag-over-above, .drag-over-below, .drag-over-child").forEach((n) => {
    n.classList.remove("drag-over-above", "drag-over-below", "drag-over-child");
  });
}

function countDescendants(rootId) {
  let count = 0;
  const childrenOf = new Map();
  for (const n of currentSnapshot.nodes) {
    const key = n.parentId == null ? "root" : n.parentId;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(n.id);
  }
  (function dfs(id) {
    for (const c of childrenOf.get(id) || []) {
      count++;
      dfs(c);
    }
  })(rootId);
  return count;
}

// Allow dropping onto the tree background (below the last item) to un-nest to root.
treeEl.addEventListener("dragover", (e) => {
  if (e.target === treeEl) e.preventDefault();
});
treeEl.addEventListener("drop", (e) => {
  if (e.target !== treeEl) return;
  if (dragTabId == null) return;
  send({ type: "MOVE_NODE", tabId: dragTabId, newParentId: null, beforeSiblingId: null });
});

function visibleNodesInOrder() {
  return currentSnapshot.nodes.filter((n) => !n.hidden || filterText);
}

treeEl.addEventListener("keydown", (e) => {
  const visible = visibleNodesInOrder();
  if (visible.length === 0) return;
  let idx = visible.findIndex((n) => n.id === keyboardFocusId);

  if (e.key === "ArrowDown") {
    e.preventDefault();
    idx = Math.min(visible.length - 1, idx + 1);
    keyboardFocusId = visible[idx].id;
    render(currentSnapshot);
    scrollFocusedIntoView();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    idx = Math.max(0, idx - 1);
    keyboardFocusId = visible[idx].id;
    render(currentSnapshot);
    scrollFocusedIntoView();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (keyboardFocusId != null) send({ type: "ACTIVATE_TAB", tabId: keyboardFocusId });
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (keyboardFocusId != null) {
      const n = visible[idx];
      if (n && n.hasChildren && !n.collapsed) {
        send({ type: "TOGGLE_COLLAPSE", tabId: n.id });
      } else if (n && n.parentId != null) {
        keyboardFocusId = n.parentId;
        render(currentSnapshot);
      }
    }
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    const n = visible[idx];
    if (n && n.hasChildren && n.collapsed) {
      send({ type: "TOGGLE_COLLAPSE", tabId: n.id });
    }
  } else if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    if (keyboardFocusId != null) {
      send({ type: "CLOSE_TAB", tabId: keyboardFocusId, closeChildren: e.shiftKey });
    }
  } else if (e.key === "/") {
    e.preventDefault();
    filterInput.focus();
  }
});

function scrollFocusedIntoView() {
  const el = treeEl.querySelector(`[data-tab-id="${keyboardFocusId}"]`);
  if (el) el.scrollIntoView({ block: "nearest" });
}

filterInput.addEventListener("input", () => {
  filterText = filterInput.value.trim().toLowerCase();
  render(currentSnapshot);
});
filterInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    filterInput.value = "";
    filterText = "";
    render(currentSnapshot);
    filterInput.blur();
  } else if (e.key === "Enter") {
    const visible = visibleNodesInOrder().filter((n) => !n.filteredOut && matchesFilter(n));
    if (visible.length > 0) {
      send({ type: "ACTIVATE_TAB", tabId: visible[0].id });
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== filterInput) {
    e.preventDefault();
    filterInput.focus();
  }
});

newTabBtn.addEventListener("click", () => send({ type: "NEW_ROOT_TAB" }));

function send(msg) {
  if (port) port.postMessage(msg);
}

async function init() {
  const win = await chrome.windows.getCurrent();
  port = chrome.runtime.connect({ name: "sidepanel" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "SNAPSHOT") render(msg.snapshot);
  });
  port.onDisconnect.addListener(() => {
    setTimeout(init, 250);
  });
  port.postMessage({ type: "INIT", windowId: win.id });
}

init();
