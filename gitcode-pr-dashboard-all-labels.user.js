// ==UserScript==
// @name         GitCode PR Dashboard: All Pages + Labels
// @namespace    https://github.com/KaranocaVe/gitcode-pr-dashboard-all-labels-userscript
// @version      1.6.0
// @updateURL    https://raw.githubusercontent.com/KaranocaVe/gitcode-pr-dashboard-all-labels-userscript/main/gitcode-pr-dashboard-all-labels.user.js
// @downloadURL  https://raw.githubusercontent.com/KaranocaVe/gitcode-pr-dashboard-all-labels-userscript/main/gitcode-pr-dashboard-all-labels.user.js
// @description  Load all GitCode pull requests in the selected status and filter by labels and repositories with include/exclude states, linked counts, and dark mode.
// @match        https://gitcode.com/dashboard/pulls*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  if (window.__gcprAllPagesLabelsInstalled) return;
  window.__gcprAllPagesLabelsInstalled = true;

  const VERSION = "1.6.0";
  const LAYOUT_CLASS = "gcpr-label-layout";
  const API_ORIGIN = "https://web-api.gitcode.com";
  const API_PATH = "/issuepr/api/v1/merge_requests";
  const PAGE_SIZE = 100;
  const PAGE_CONCURRENCY = 3;
  const TOOLBAR_ID = "gcpr-full-label-toolbar";
  const STATUS_ID = "gcpr-full-label-status";
  const STYLE_ID = "gcpr-full-label-style";
  const HIDDEN_CLASS = "gcpr-full-label-hidden";
  const PAGER_HIDDEN_CLASS = "gcpr-full-pagination-hidden";
  const LIST_LOADING_CLASS = "gcpr-full-list-loading";
  const ownRequestUrls = new Set();
  const requestTemplates = new Map();
  const selectedLabels = new Set();
  const selectedRepositories = new Set();
  const excludedLabels = new Set();
  const excludedRepositories = new Set();
  const filters = {
    label: {title:"Label", description:"label", selected:selectedLabels, excluded:excludedLabels},
    repository: {title:"仓库", description:"仓库", selected:selectedRepositories, excluded:excludedRepositories}
  };
  const stateNames = {neutral:"不限", include:"包含", exclude:"排除"};
  const stateSymbols = {neutral:"○", include:"+", exclude:"−"};
  const nextStates = {neutral:"include", include:"exclude", exclude:"neutral"};
  const recordSnapshots = new WeakMap();
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

  let requestObserver;
  let domObserver;
  let themeObserver;
  let themeTargets = [];
  let colorContext = null;
  let templateRow = null;
  let labelTemplate = null;
  let activeRequestKey = "";
  let loadedRequestKey = "";
  let loadedState = "";
  let loadedRecords = [];
  let lastStatusMessage = "正在请求当前状态的全部 PR 页面…";
  let lastStatusKind = "info";
  let currentController = null;
  let generation = 0;
  let loading = false;
  let chromeQueued = false;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const getMain = () => document.querySelector(".pd-pulls");
  const getList = () => document.querySelector(".pd-pulls .list-surface");
  const getRows = () => [...document.querySelectorAll(".pd-pulls .list-item--pull")];
  const normalize = (value) => (value || "").trim().toLocaleLowerCase();

  function getActiveState() {
    const params = new URL(location.href).searchParams;
    const fromUrl = params.get("state");
    if (["opened", "closed", "merged", "all"].includes(fromUrl)) return fromUrl;
    const tab = getMain()?.querySelector('[role="tab"][aria-selected="true"]');
    const text = normalize(tab?.innerText).replace(/\s+\d[\d,]*/, "").trim();
    return ({open:"opened",closed:"closed",merged:"merged",all:"all"})[text] || "opened";
  }

  function queryKey(value) {
    const url = new URL(value);
    url.searchParams.delete("page");
    url.searchParams.delete("per_page");
    url.hash = "";
    return url.origin + url.pathname + "?" + url.searchParams.toString();
  }

  function safeInternalUrl(path) {
    try {
      const candidate = new URL(path, location.origin);
      return candidate.origin === location.origin ? candidate.href : location.origin + "/";
    } catch {
      return location.origin + "/";
    }
  }

  function pathHref(projectPath, suffix) {
    const path = String(projectPath || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const tail = String(suffix || "").split("/").map((part) => encodeURIComponent(part)).join("/");
    return safeInternalUrl("/" + path + (tail ? "/" + tail : ""));
  }

  function safeAvatarUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && (url.hostname === "gitcode.com" || url.hostname.endsWith(".gitcode.com")) ? url.href : "";
    } catch {
      return "";
    }
  }

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TOOLBAR_ID},#${STATUS_ID}{
        --gcpr-bg:#fff;--gcpr-text:#24292f;--gcpr-muted:#59636e;--gcpr-border:#d0d7de;
        --gcpr-hover:#f3f5f7;--gcpr-hover-border:#8796a5;--gcpr-focus:#0969da;
        --gcpr-include-bg:#e8f0fe;--gcpr-include-text:#174ea6;--gcpr-include-border:#2865e0;
        --gcpr-exclude-bg:#fff0ee;--gcpr-exclude-text:#aa2720;--gcpr-exclude-border:#cb3a31;
        color-scheme:light;
      }
      #${TOOLBAR_ID}[data-gcpr-theme="dark"],#${STATUS_ID}[data-gcpr-theme="dark"]{
        --gcpr-bg:#1f252d;--gcpr-text:#e6edf3;--gcpr-muted:#a5b2c0;--gcpr-border:#485565;
        --gcpr-hover:#2b3440;--gcpr-hover-border:#8796a5;--gcpr-focus:#79b8ff;
        --gcpr-include-bg:#15335b;--gcpr-include-text:#a9d0ff;--gcpr-include-border:#6aa9ff;
        --gcpr-exclude-bg:#4b2026;--gcpr-exclude-text:#ffb8b0;--gcpr-exclude-border:#f5827b;
        color-scheme:dark;
      }
      .${LAYOUT_CLASS}{display:flex!important;flex-direction:row!important;flex-wrap:wrap!important;align-items:center;gap:14px;min-width:0}
      .${LAYOUT_CLASS}>*{flex:0 0 100%;min-width:0;max-width:100%;box-sizing:border-box}
      .${LAYOUT_CLASS}>.collab-status-tabs{flex:0 1 auto!important;width:auto!important;min-width:0!important;max-width:100%!important}
      .${LAYOUT_CLASS}>#${TOOLBAR_ID}{flex:0 0 100%!important;width:100%!important;min-width:0!important;max-width:100%!important}
      #${TOOLBAR_ID}{display:flex;flex-direction:column;align-items:stretch;gap:8px;box-sizing:border-box;margin:0;min-height:34px}
      #${TOOLBAR_ID} .gcpr-filter-strip{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;overflow:hidden}
      #${TOOLBAR_ID} .gcpr-filter-heading{display:flex;align-items:center;gap:6px;flex:0 0 auto;white-space:nowrap;font-size:12px;color:var(--gcpr-muted)}
      #${TOOLBAR_ID} .gcpr-filter-items{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;padding:4px 3px;scrollbar-width:thin;scrollbar-color:var(--gcpr-border) transparent}
      #${TOOLBAR_ID} .gcpr-filter-pill{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;max-width:260px;border:1px solid var(--gcpr-border);border-radius:999px;padding:4px 9px;background:var(--gcpr-bg);color:var(--gcpr-text);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
      #${TOOLBAR_ID} .gcpr-filter-pill[data-state="neutral"]:hover:not(:disabled){border-color:var(--gcpr-hover-border);background:var(--gcpr-hover)}
      #${TOOLBAR_ID} .gcpr-filter-pill[data-state="include"]{border-color:var(--gcpr-include-border);background:var(--gcpr-include-bg);color:var(--gcpr-include-text)}
      #${TOOLBAR_ID} .gcpr-filter-pill[data-state="exclude"]{border-color:var(--gcpr-exclude-border);background:var(--gcpr-exclude-bg);color:var(--gcpr-exclude-text)}
      #${TOOLBAR_ID} .gcpr-filter-pill[data-state="exclude"] .gcpr-filter-name{text-decoration:line-through}
      #${TOOLBAR_ID} button:focus-visible{outline:2px solid var(--gcpr-focus);outline-offset:1px}
      #${TOOLBAR_ID} .gcpr-filter-pill:disabled{opacity:.55;cursor:not-allowed}
      #${TOOLBAR_ID} .gcpr-filter-state{flex:0 0 1em;text-align:center;font-weight:700}
      #${TOOLBAR_ID} .gcpr-filter-name{overflow:hidden;text-overflow:ellipsis}
      #${TOOLBAR_ID} .gcpr-filter-count{font-size:11px;font-weight:700;opacity:.95}
      #${TOOLBAR_ID} .gcpr-filter-clear{flex:0 0 auto;border:0;background:transparent;color:var(--gcpr-muted);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
      #${TOOLBAR_ID} .gcpr-filter-clear[hidden]{display:none}
      #${TOOLBAR_ID} .gcpr-filter-help{color:var(--gcpr-muted);font-size:12px;line-height:1.6}
      #${TOOLBAR_ID} .gcpr-export-json{flex:0 0 auto;border:1px solid var(--gcpr-border);border-radius:6px;padding:4px 9px;background:var(--gcpr-bg);color:var(--gcpr-text);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
      #${TOOLBAR_ID} .gcpr-export-json:hover:not(:disabled){background:var(--gcpr-hover);border-color:var(--gcpr-hover-border)}
      #${TOOLBAR_ID} .gcpr-export-json:disabled{opacity:.55;cursor:not-allowed}
      #${STATUS_ID}{margin:0 0 10px;color:var(--gcpr-muted);font-size:12px}
      .pd-pulls .list-item--pull.${HIDDEN_CLASS}{display:none!important}
      .pd-pulls .issue-pagination.${PAGER_HIDDEN_CLASS}{display:none!important}
      .pd-pulls .list-surface.${LIST_LOADING_CLASS}{display:none!important}
    `;
    document.head.append(style);
  }

  function pageUsesDarkTheme(targets) {
    const scheme = getComputedStyle(document.documentElement).colorScheme;
    let fallback = scheme === "dark" ? true : scheme === "light" ? false : systemTheme.matches;
    for (const node of [...targets].reverse()) {
      const hint = [node.getAttribute("data-theme"), node.getAttribute("data-color-mode"),
        node.getAttribute("data-bs-theme"), node.getAttribute("theme"), node.className].join(" ");
      if (/(?:^|[\s_-])(dark|night)(?:$|[\s_-])/i.test(hint)) fallback = true;
      else if (/(?:^|[\s_-])(light|day)(?:$|[\s_-])/i.test(hint)) fallback = false;
    }
    try {
      if (!colorContext) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        colorContext = canvas.getContext("2d", {willReadFrequently:true});
      }
      if (!colorContext) return fallback;
      const layers = [];
      for (const node of targets) {
        colorContext.clearRect(0, 0, 1, 1);
        colorContext.fillStyle = "transparent";
        colorContext.fillStyle = getComputedStyle(node).backgroundColor;
        colorContext.fillRect(0, 0, 1, 1);
        const color = colorContext.getImageData(0, 0, 1, 1).data;
        if (color[3]) layers.push([...color]);
        if (color[3] === 255) break;
      }
      if (!layers.length) return fallback;
      let background = fallback ? [18, 18, 18] : [255, 255, 255];
      for (const [red, green, blue, opacity] of layers.reverse()) {
        const alpha = opacity / 255;
        background = [red, green, blue].map((value, index) => value * alpha + background[index] * (1 - alpha));
      }
      const linear = background.map((value) => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2] < .35;
    } catch {
      return fallback;
    }
  }

  function syncTheme() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    const main = getMain();
    if (!toolbar || !main) return;
    const targets = [];
    for (let node = main; node; node = node.parentElement) targets.push(node);
    if (targets.length !== themeTargets.length || targets.some((node, index) => node !== themeTargets[index])) {
      themeObserver?.disconnect();
      themeTargets = targets;
      if (!themeObserver) themeObserver = new MutationObserver(scheduleChrome);
      for (const node of targets) themeObserver.observe(node, {
        attributes:true,
        attributeFilter:["class", "style", "data-theme", "data-color-mode", "data-bs-theme", "theme"]
      });
    }
    const theme = pageUsesDarkTheme(targets) ? "dark" : "light";
    for (const node of [toolbar, document.getElementById(STATUS_ID)]) {
      if (node && node.dataset.gcprTheme !== theme) node.dataset.gcprTheme = theme;
    }
  }

  function filterState(filter, value) {
    return filter.excluded.has(value) ? "exclude" : filter.selected.has(value) ? "include" : "neutral";
  }

  function setFilterState(filter, value, state) {
    filter.selected.delete(value);
    filter.excluded.delete(value);
    if (state === "include") filter.selected.add(value);
    if (state === "exclude") filter.excluded.add(value);
  }

  function snapshotRecord(record) {
    let snapshot = recordSnapshots.get(record);
    if (!snapshot) {
      snapshot = {repository:repositoryKey(record.projectPath), labels:new Set(record.labels.map((label) => normalize(label.name)))};
      recordSnapshots.set(record, snapshot);
    }
    return snapshot;
  }

  function matchesDimension(kind, snapshot, filter = filters[kind]) {
    if (kind === "repository") {
      return !filter.excluded.has(snapshot.repository) && (filter.selected.size === 0 || filter.selected.has(snapshot.repository));
    }
    for (const value of filter.selected) if (!snapshot.labels.has(value)) return false;
    for (const value of filter.excluded) if (snapshot.labels.has(value)) return false;
    return true;
  }

  function matchesSnapshot(snapshot) {
    return matchesDimension("label", snapshot) && matchesDimension("repository", snapshot);
  }

  function setStatus(message, kind) {
    const previousKind = lastStatusKind;
    lastStatusMessage = message;
    lastStatusKind = kind || "info";
    if (previousKind !== lastStatusKind) renderFilterPills(loadedRecords);
    updateExportButton();
    const status = document.getElementById(STATUS_ID);
    if (!status) return;
    status.textContent = lastStatusMessage + " · v" + VERSION;
    status.dataset.version = VERSION;
    status.dataset.kind = lastStatusKind;
  }

  function createFilterStrip(kind) {
    const filter = filters[kind];
    const strip = document.createElement("div");
    strip.className = "gcpr-filter-strip gcpr-" + kind + "-strip";

    const heading = document.createElement("div");
    heading.className = "gcpr-filter-heading";
    const title = document.createElement("span");
    title.textContent = filter.title;
    const loaded = document.createElement("span");
    loaded.className = "gcpr-" + kind + "-loaded";
    heading.append(title, loaded);

    const items = document.createElement("div");
    items.className = "gcpr-filter-items gcpr-" + kind + "-items";
    items.setAttribute("role", "group");
    items.setAttribute("aria-label", "PR " + filter.description + " 及命中数量");

    const clear = document.createElement("button");
    clear.className = "gcpr-filter-clear gcpr-" + kind + "-clear";
    clear.type = "button";
    clear.dataset.filter = kind;
    clear.setAttribute("aria-label", "清除所有" + filter.description + "筛选");
    clear.hidden = true;
    clear.textContent = "清除";
    strip.append(heading, items, clear);

    if (kind === "label") {
      const exportButton = document.createElement("button");
      exportButton.className = "gcpr-export-json";
      exportButton.type = "button";
      exportButton.disabled = true;
      exportButton.textContent = "导出 JSON";
      strip.append(exportButton);
    }
    return strip;
  }

  function ensureControls() {
    const main = getMain();
    const tabs = main?.querySelector(".collab-status-tabs");
    if (!main || !tabs) return null;
    addStyles();
    const layout = tabs.parentElement;
    if (!layout.classList.contains(LAYOUT_CLASS)) layout.classList.add(LAYOUT_CLASS);

    let toolbar = main.querySelector("#" + TOOLBAR_ID);
    let rebuilt = false;
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.id = TOOLBAR_ID;
      toolbar.setAttribute("role", "group");
      toolbar.setAttribute("aria-label", "按 label 和仓库筛选完整 PR 列表");
      toolbar.dataset.version = VERSION;
      rebuilt = true;
    }

    for (const kind of Object.keys(filters)) {
      const strip = toolbar.querySelector(".gcpr-" + kind + "-strip");
      if (!strip || !strip.querySelector(".gcpr-" + kind + "-items") ||
          !strip.querySelector(".gcpr-" + kind + "-loaded") || !strip.querySelector(".gcpr-" + kind + "-clear") ||
          (kind === "label" && !strip.querySelector(".gcpr-export-json"))) {
        strip?.remove();
        const replacement = createFilterStrip(kind);
        if (kind === "label") toolbar.prepend(replacement);
        else toolbar.append(replacement);
        rebuilt = true;
      }
    }

    let help = toolbar.querySelector(".gcpr-filter-help");
    if (!help) {
      help = document.createElement("div");
      help.className = "gcpr-filter-help";
      help.textContent = "点击循环：○ 不限 → + 包含 → − 排除 → ○ 不限；→ 数字为下次点击后的条数";
    }
    if (toolbar.lastElementChild !== help) toolbar.append(help);

    if (toolbar.previousElementSibling !== tabs || toolbar.parentElement !== layout) {
      tabs.insertAdjacentElement("afterend", toolbar);
    }

    if (toolbar.dataset.gcprEventsBound !== "true") {
      toolbar.dataset.gcprEventsBound = "true";
      toolbar.addEventListener("click", (event) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest(".gcpr-export-json")) {
          exportCurrentList();
          return;
        }
        const clear = event.target.closest(".gcpr-filter-clear");
        if (clear) {
          const filter = filters[clear.dataset.filter];
          if (!filter) return;
          filter.selected.clear();
          filter.excluded.clear();
          renderFilterPills(loadedRecords);
          applyFilters();
          return;
        }
        const pill = event.target.closest(".gcpr-filter-pill");
        if (!pill || pill.disabled) return;
        const filter = filters[pill.dataset.filter];
        if (!filter) return;
        const value = pill.dataset.value;
        const state = filterState(filter, value);
        if (!canExportCurrentList() && state === "neutral") return;
        setFilterState(filter, value, nextStates[state]);
        renderFilterPills(loadedRecords);
        applyFilters();
      });
    }

    let status = document.getElementById(STATUS_ID);
    if (!status) {
      status = document.createElement("div");
      status.id = STATUS_ID;
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      toolbar.insertAdjacentElement("afterend", status);
      setStatus(lastStatusMessage, lastStatusKind);
    } else if (status.previousElementSibling !== toolbar) {
      toolbar.insertAdjacentElement("afterend", status);
    }

    if (rebuilt || toolbar.dataset.gcprFiltersKey !== loadedRequestKey) {
      renderFilterPills(loadedRecords);
      if (loadedRequestKey && loadedState === getActiveState()) {
        setStatus(lastStatusMessage, lastStatusKind);
      }
    }
    updateExportButton();
    syncTheme();
    return toolbar;
  }

  function recordLabels(record) {
    const values = [...(record.labels || []), ...(record.enterprise_labels || [])];
    const byName = new Map();
    for (const value of values) {
      const label = typeof value === "string" ? {name:value} : value || {};
      const name = String(label.name || label.title || "").trim();
      if (!name) continue;
      byName.set(name, {
        name,
        color: label.color || label.background_color || "#8c959f",
        textColor: label.text_color || label.textColor || ""
      });
    }
    return [...byName.values()];
  }

  function normalizeRecord(record) {
    const target = record.target_project || {};
    const source = record.source_project || {};
    const author = record.author || {};
    const projectPath = target.path_with_namespace || target.name_with_namespace || target.path || target.name || "";
    const sourcePath = source.path_with_namespace || source.name_with_namespace || projectPath;
    const username = author.username || author.name || "";
    return {
      key: String(record.id || (projectPath + "#" + record.iid)),
      iid: record.iid,
      projectPath,
      sourcePath,
      title: String(record.title || "(untitled pull request)"),
      state: String(record.state || ""),
      labels: recordLabels(record),
      createdAt: record.created_at || "",
      updatedAt: record.updated_at || record.created_at || "",
      sourceBranch: String(record.source_branch || ""),
      targetBranch: String(record.target_branch || ""),
      addedLines: Number(record.added_lines || 0),
      removedLines: Number(record.removed_lines || 0),
      authorName: String(author.nick_name || author.name_cn || author.name || username || "Unknown"),
      authorUsername: String(username),
      authorUrl: String(author.web_url || ""),
      avatarUrl: String(author.avatar_url || "")
    };
  }

  function summarizeLabels(records) {
    const counts = new Map();
    for (const record of records) {
      const seen = new Set();
      for (const label of record.labels) {
        const value = normalize(label.name);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        const entry = counts.get(value) || {value, name:label.name, count:0};
        entry.count += 1;
        counts.set(value, entry);
      }
    }
    return [...counts.values()].sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function repositoryKey(projectPath) {
    return String(projectPath || "").trim();
  }

  function summarizeRepositories(records) {
    const counts = new Map();
    for (const record of records) {
      const value = repositoryKey(record.projectPath);
      const entry = counts.get(value) || {value, name:record.projectPath || "未知仓库", count:0};
      entry.count += 1;
      counts.set(value, entry);
    }
    return [...counts.values()].sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function summarizeFilterCounts(records) {
    const snapshots = records.map(snapshotRecord);
    const result = {matching:snapshots.filter(matchesSnapshot).length};
    for (const [kind, filter] of Object.entries(filters)) {
      const other = kind === "label" ? "repository" : "label";
      const eligible = snapshots.filter((snapshot) => matchesDimension(other, snapshot));
      const totals = kind === "label" ? summarizeLabels(records) : summarizeRepositories(records);
      result[kind] = totals.map((entry) => {
        const state = filterState(filter, entry.value);
        const next = nextStates[state];
        const candidate = {selected:new Set(filter.selected), excluded:new Set(filter.excluded)};
        setFilterState(candidate, entry.value, next);
        const count = eligible.reduce((sum, snapshot) => sum + Number(matchesDimension(kind, snapshot, candidate)), 0);
        return {...entry, total:entry.count, count, state, next};
      });
    }
    return result;
  }

  function renderFilterPills(records) {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;
    toolbar.dataset.gcprFiltersKey = loadedRequestKey;
    const ready = canExportCurrentList();
    const counts = summarizeFilterCounts(records);

    for (const [kind, filter] of Object.entries(filters)) {
      const items = toolbar.querySelector(".gcpr-" + kind + "-items");
      const loaded = toolbar.querySelector(".gcpr-" + kind + "-loaded");
      const clear = toolbar.querySelector(".gcpr-" + kind + "-clear");
      if (!items || !loaded || !clear) continue;
      const entries = counts[kind];
      const active = filter.selected.size + filter.excluded.size;
      const selection = active ? " · 含 " + filter.selected.size + " / 排 " + filter.excluded.size : " · 不限";
      const summary = !ready ? (loading ? "正在加载…" : "等待完整列表") : kind === "label"
        ? "命中 " + counts.matching + " / " + records.length + " 条" + selection
        : "共 " + entries.length + " 个" + selection;
      if (loaded.textContent !== summary) loaded.textContent = summary;

      if (!entries.length) {
        const message = loading ? "正在读取" + filter.description + "…" : "当前列表没有" + filter.description;
        let empty = items.querySelector(".gcpr-filter-empty");
        if (!empty || items.children.length !== 1) {
          empty = document.createElement("span");
          empty.className = "gcpr-filter-name gcpr-filter-empty";
          items.replaceChildren(empty);
        }
        if (empty.textContent !== message) empty.textContent = message;
      } else {
        const existing = new Map([...items.querySelectorAll(".gcpr-filter-pill")].map((pill) => [pill.dataset.value, pill]));
        const desired = [];
        for (const {value, name, count, total, state, next} of entries) {
          let pill = existing.get(value);
          if (!pill || !pill.querySelector(".gcpr-filter-state")) {
            pill = document.createElement("button");
            pill.type = "button";
            pill.className = "gcpr-filter-pill";
            pill.dataset.filter = kind;
            pill.dataset.value = value;
            const marker = document.createElement("span");
            marker.className = "gcpr-filter-state";
            marker.setAttribute("aria-hidden", "true");
            const text = document.createElement("span");
            text.className = "gcpr-filter-name";
            const badge = document.createElement("span");
            badge.className = "gcpr-filter-count";
            badge.setAttribute("aria-hidden", "true");
            pill.append(marker, text, badge);
          }
          if (pill.dataset.state !== state) pill.dataset.state = state;
          const pressed = state === "neutral" ? "false" : state === "include" ? "true" : "mixed";
          if (pill.getAttribute("aria-pressed") !== pressed) pill.setAttribute("aria-pressed", pressed);
          // All ready options, including zero counts, must allow cycling into exclusion.
          const disabled = !ready && state === "neutral";
          if (pill.disabled !== disabled) pill.disabled = disabled;
          const description = name + "；当前：" + stateNames[state] + "；下次点击：" + stateNames[next] + "；" + (ready
            ? "点击后命中 " + count + " 条 PR；该项原始数量 " + total + " 条"
            : "等待当前列表完整加载，数量暂不可用");
          if (pill.title !== description) pill.title = description;
          if (pill.getAttribute("aria-label") !== description) pill.setAttribute("aria-label", description);
          const marker = pill.querySelector(".gcpr-filter-state");
          if (marker.textContent !== stateSymbols[state]) marker.textContent = stateSymbols[state];
          const text = pill.querySelector(".gcpr-filter-name");
          if (text.textContent !== name) text.textContent = name;
          const badge = pill.querySelector(".gcpr-filter-count");
          const countText = ready ? "→" + count : "—";
          if (badge.textContent !== countText) badge.textContent = countText;
          desired.push(pill);
        }
        for (let index = 0; index < desired.length; index += 1) {
          if (items.children[index] !== desired[index]) items.insertBefore(desired[index], items.children[index] || null);
        }
        while (items.children.length > desired.length) items.lastElementChild.remove();
      }
      if (clear.hidden !== (active === 0)) clear.hidden = active === 0;
    }
    updateExportButton();
  }

  function relativeTime(value) {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    const days = Math.floor(hours / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    const months = Math.floor(days / 30);
    if (months < 12) return months + (months === 1 ? " month ago" : " months ago");
    const years = Math.floor(months / 12);
    return years + (years === 1 ? " year ago" : " years ago");
  }

  function setLink(anchor, text, href) {
    if (!anchor) return;
    anchor.textContent = text;
    anchor.href = safeInternalUrl(href);
    anchor.title = text;
    anchor.rel = "noopener noreferrer";
  }

  function createLabelTag(label) {
    let tag = labelTemplate ? labelTemplate.cloneNode(true) : document.createElement("div");
    tag.className = "g-label-tag";
    let text = tag.querySelector(".g-label-tag-text");
    if (!text) {
      text = document.createElement("span");
      text.className = "g-label-tag-text";
      tag.append(text);
    }
    const color = /^#[0-9a-f]{3,8}$/i.test(label.color) ? label.color : "#8c959f";
    tag.style.setProperty("--v306f4b7e", "12px");
    tag.style.setProperty("--v42ca7a14", "#fbfbfb");
    tag.style.setProperty("--v440802ba", "0");
    tag.style.setProperty("--v42f10457", "transparent");
    tag.style.setProperty("--v5b27d2f6", color);
    text.textContent = label.name;
    text.title = label.name;
    if (/^#[0-9a-f]{3,8}$/i.test(label.textColor)) text.style.color = label.textColor;
    return tag;
  }

  function makeRow(record) {
    if (!templateRow) {
      const simple = document.createElement("article");
      simple.className = "list-item list-item--pull";
      const title = document.createElement("a");
      title.className = "list-item-title-link";
      title.textContent = record.title;
      title.href = pathHref(record.projectPath, "pull/" + record.iid);
      const titleBox = document.createElement("div");
      titleBox.className = "list-item-title";
      titleBox.append(title);
      for (const label of record.labels) titleBox.append(createLabelTag(label));
      simple.append(titleBox);
      simple.dataset.gcprGenerated = "true";
      simple.dataset.gcprKey = record.key;
      return simple;
    }

    const row = templateRow.cloneNode(true);
    row.classList.remove(HIDDEN_CLASS);
    row.dataset.gcprGenerated = "true";
    row.dataset.gcprKey = record.key;

    const titleLink = row.querySelector(".list-item-title-link");
    setLink(titleLink, record.title, pathHref(record.projectPath, "pull/" + record.iid));
    const titleBox = titleLink?.parentElement;
    titleBox?.querySelectorAll(".g-label-tag").forEach((node) => node.remove());
    if (titleBox) for (const label of record.labels) titleBox.append(createLabelTag(label));

    const meta = row.querySelector(".list-item-meta");
    const repoLink = meta?.querySelector(".meta-repo");
    setLink(repoLink, record.projectPath, "/" + record.projectPath.split("/").map(encodeURIComponent).join("/"));
    const numberLink = meta?.querySelector("a.mono");
    setLink(numberLink, "#" + record.iid, pathHref(record.projectPath, "pull/" + record.iid));

    const authorBox = meta?.querySelector(".meta-user");
    const authorLink = authorBox?.querySelector("a");
    if (authorBox) {
      authorBox.hidden = !record.authorUsername;
      const authorHref = record.authorUrl.startsWith("https://gitcode.com/") ? record.authorUrl : pathHref(record.authorUsername, "");
      setLink(authorLink, record.authorName, authorHref);
      const avatar = authorBox.querySelector(".g-avatar__img");
      const avatarUrl = safeAvatarUrl(record.avatarUrl);
      if (avatar) {
        avatar.alt = record.authorName;
        if (avatarUrl) avatar.src = avatarUrl;
        else avatar.removeAttribute("src");
      }
      const avatarBox = authorBox.querySelector(".g-avatar");
      if (avatarBox) avatarBox.hidden = !avatarUrl;
    }

    const createdBox = [...(meta?.children || [])].find((node) => node.tagName === "SPAN" && !node.className && node.querySelector("time"));
    if (createdBox) {
      const time = createdBox.querySelector("time");
      time.textContent = relativeTime(record.createdAt);
      time.dateTime = record.createdAt;
      createdBox.replaceChildren(document.createTextNode("Add on "), time);
    }

    const branchBox = meta?.querySelector(".meta-branch");
    if (branchBox) {
      const links = [...branchBox.querySelectorAll("a")];
      if (links.length >= 2) {
        const sourceLink = links[0];
        const targetLink = links[1];
        const sourceStrong = sourceLink.querySelector("strong") || sourceLink;
        const targetStrong = targetLink.querySelector("strong") || targetLink;
        const sourceText = record.sourceBranch || "unknown";
        const targetText = record.targetBranch || "unknown";
        sourceStrong.textContent = sourceText;
        targetStrong.textContent = targetText;
        sourceLink.href = pathHref(record.sourcePath, "tree/" + record.sourceBranch);
        sourceLink.title = sourceText;
        targetLink.href = pathHref(record.projectPath, "tree/" + record.targetBranch);
        targetLink.title = targetText;
        branchBox.replaceChildren(document.createTextNode("Merged from "), sourceLink, document.createTextNode(" into "), targetLink);
      }
    }

    const diff = meta?.querySelector(".diff");
    if (diff) {
      const added = diff.querySelector(".add");
      const removed = diff.querySelector(".del");
      if (added) added.textContent = "+" + record.addedLines;
      if (removed) removed.textContent = "-" + record.removedLines;
    }

    const updated = row.querySelector(".list-item-trail time");
    if (updated) {
      updated.textContent = "Updated on " + relativeTime(record.updatedAt);
      updated.dateTime = record.updatedAt;
    }
    return row;
  }

  function matchesFilters(projectPath, labelNames) {
    return matchesSnapshot({repository:repositoryKey(projectPath), labels:new Set(labelNames.map(normalize))});
  }

  function filteredRecords() {
    return loadedRecords.filter((record) => matchesSnapshot(snapshotRecord(record)));
  }

  function canExportCurrentList() {
    const list = getList();
    return !loading && lastStatusKind === "complete" && Boolean(loadedRequestKey) &&
      loadedRequestKey === activeRequestKey && loadedState === getActiveState() &&
      list?.dataset.gcprFullLoaded === "true" && list.dataset.gcprQueryKey === loadedRequestKey;
  }

  function updateExportButton() {
    const button = document.querySelector("#" + TOOLBAR_ID + " .gcpr-export-json");
    if (!button) return;
    const ready = canExportCurrentList();
    const text = ready ? "导出 JSON（" + filteredRecords().length + "）" : "导出 JSON";
    const title = ready ? "导出当前 label 和仓库筛选后的完整 PR 列表" : "请等待当前列表完整加载";
    if (button.disabled !== !ready) button.disabled = !ready;
    if (button.textContent !== text) button.textContent = text;
    if (button.title !== title) button.title = title;
  }

  function exportCurrentList() {
    if (!canExportCurrentList()) return;
    const records = filteredRecords().map((record) => ({
      ...record,
      url: pathHref(record.projectPath, "pull/" + record.iid)
    }));
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blob = new Blob([JSON.stringify(records, null, 2) + "\n"], {type:"application/json;charset=utf-8"});
    const address = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = address;
    anchor.download = "gitcode-pulls-" + loadedState + "-" + records.length + "-" + timestamp + ".json";
    anchor.hidden = true;
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(address), 1000);
    }
  }

  function applyFilters() {
    const list = getList();
    if (!list) return;
    const matchingKeys = new Set(filteredRecords().map((record) => record.key));
    for (const row of list.querySelectorAll(".list-item--pull")) {
      if (row.dataset.gcprGenerated === "true") {
        row.classList.toggle(HIDDEN_CLASS, !matchingKeys.has(row.dataset.gcprKey));
      } else {
        const labels = [...row.querySelectorAll(".g-label-tag-text")].map((node) => node.getAttribute("title") || node.textContent);
        const projectPath = row.querySelector(".meta-repo")?.textContent || "";
        row.classList.toggle(HIDDEN_CLASS, !matchesFilters(projectPath, labels));
      }
    }
    updateExportButton();
  }

  function renderRecords(records, key) {
    const list = getList();
    if (!list) throw new Error("PR list container not found");
    if (!templateRow) templateRow = document.querySelector(".list-item--pull")?.cloneNode(true) || null;
    if (!labelTemplate) labelTemplate = document.querySelector(".g-label-tag")?.cloneNode(true) || null;

    const fragment = document.createDocumentFragment();
    for (const record of records) fragment.append(makeRow(record));
    list.replaceChildren(fragment);
    list.dataset.gcprFullLoaded = "true";
    list.dataset.gcprQueryKey = key;
    list.classList.remove(LIST_LOADING_CLASS);
    document.querySelector(".issue-pagination")?.classList.add(PAGER_HIDDEN_CLASS);
    loadedRecords = records;
    const availableFilters = {
      label: new Set(records.flatMap((record) => record.labels.map((label) => normalize(label.name)))),
      repository: new Set(records.map((record) => repositoryKey(record.projectPath)))
    };
    for (const [kind, filter] of Object.entries(filters)) {
      for (const values of [filter.selected, filter.excluded]) {
        for (const value of values) {
          if (!availableFilters[kind].has(value)) values.delete(value);
        }
      }
    }
    renderFilterPills(records);
    applyFilters();
  }

  function setLoadingUi(message) {
    ensureControls();
    setStatus(message, "loading");
    renderFilterPills(loadedRecords);
    getList()?.classList.add(LIST_LOADING_CLASS);
    document.querySelector(".issue-pagination")?.classList.add(PAGER_HIDDEN_CLASS);
  }

  function restoreNativePage(message, kind) {
    getList()?.classList.remove(LIST_LOADING_CLASS);
    document.querySelector(".issue-pagination")?.classList.remove(PAGER_HIDDEN_CLASS);
    setStatus(message, kind || "error");
  }

  function normalizeResponse(payload) {
    const content = Array.isArray(payload?.content) ? payload.content.map(normalizeRecord) : null;
    if (!content) throw new Error("GitCode returned an unexpected PR response");
    return {
      records: content,
      total: Number(payload.total || 0),
      pageCount: Number(payload.page_count || (payload.total ? Math.ceil(payload.total / PAGE_SIZE) : 0)),
      page: Number(payload.page_num || 1)
    };
  }

  async function fetchPage(baseUrl, pageNumber, signal) {
    const url = new URL(baseUrl);
    url.searchParams.set("page", String(pageNumber));
    url.searchParams.set("per_page", String(PAGE_SIZE));
    const address = url.href;
    ownRequestUrls.add(address);

    const token = localStorage.getItem("access_token");
    if (!token) throw new Error("登录凭据不可用");
    const response = await fetch(address, {
      method: "GET",
      credentials: "include",
      headers: {Authorization:"Bearer " + token, Accept:"application/json"},
      signal
    });
    if (!response.ok) throw new Error("GitCode 接口返回 HTTP " + response.status);
    return normalizeResponse(await response.json());
  }

  function uniqueRecords(pages, pageCount) {
    const unique = new Map();
    for (let page = 1; page <= pageCount; page += 1) {
      for (const record of pages.get(page)?.records || []) unique.set(record.key, record);
    }
    return [...unique.values()];
  }

  function samePage(a, b) {
    return (a || []).map((item) => item.key).join("|") === (b || []).map((item) => item.key).join("|");
  }

  async function fetchDataset(baseUrl, requestGeneration, signal) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (requestGeneration !== generation) return null;
      setStatus(attempt ? "列表数据发生变化，重新读取并校验…" : "正在读取第一页…", "loading");
      const pages = new Map();
      const first = await fetchPage(baseUrl, 1, signal);
      pages.set(1, first);
      let pageCount = first.pageCount;
      let total = first.total;
      let completed = 1;

      for (let start = 2; start <= pageCount; start += PAGE_CONCURRENCY) {
        if (requestGeneration !== generation) return null;
        const numbers = [];
        for (let page = start; page < start + PAGE_CONCURRENCY && page <= pageCount; page += 1) numbers.push(page);
        const batch = await Promise.all(numbers.map((pageNumber) => fetchPage(baseUrl, pageNumber, signal)));
        for (let i = 0; i < numbers.length; i += 1) {
          pages.set(numbers[i], batch[i]);
          if (batch[i].pageCount > pageCount) pageCount = batch[i].pageCount;
          total = batch[i].total;
        }
        completed += batch.length;
        const collected = [...pages.values()].reduce((sum, page) => sum + page.records.length, 0);
        setStatus("正在读取第 " + completed + " / " + pageCount + " 页 · 已取得 " + collected + " / " + total + " 条", "loading");
        await delay(120);
      }

      if (requestGeneration !== generation) return null;
      setStatus("正在校验总数…", "loading");
      const confirmation = await fetchPage(baseUrl, 1, signal);
      const drifted = confirmation.total !== total || confirmation.pageCount !== pageCount ||
        !samePage(first.records, confirmation.records);
      pages.set(1, confirmation);
      total = confirmation.total;
      pageCount = confirmation.pageCount;

      if (drifted && attempt === 0) continue;
      if (drifted) throw new Error("列表在加载期间持续变化，请稍后重试");
      const records = uniqueRecords(pages, pageCount);
      const allPagesPresent = pageCount === 0 || Array.from({length:pageCount}, (_, i) => pages.has(i + 1)).every(Boolean);
      if (!allPagesPresent || records.length !== total) {
        if (attempt === 0) continue;
        throw new Error("已读取 " + records.length + " / " + total + " 条，未能校验完整页集");
      }
      return {records,total,pageCount};
    }
    throw new Error("全量读取失败");
  }

  async function loadAllPages(rawUrl) {
    const base = new URL(rawUrl);
    const key = queryKey(base.href);
    if (loading && key === activeRequestKey) return;
    if (!loading && key === loadedRequestKey) return;

    generation += 1;
    const requestGeneration = generation;
    currentController?.abort();
    currentController = new AbortController();
    activeRequestKey = key;
    loading = true;
    templateRow = document.querySelector(".list-item--pull")?.cloneNode(true) || templateRow;
    labelTemplate = document.querySelector(".g-label-tag")?.cloneNode(true) || labelTemplate;
    setLoadingUi("正在后台加载当前状态的全部 PR 页面…");

    try {
      const result = await fetchDataset(base.href, requestGeneration, currentController.signal);
      if (!result || requestGeneration !== generation) return;
      loadedRequestKey = key;
      loadedState = base.searchParams.get("state") || getActiveState();
      renderRecords(result.records, key);
      loading = false;
      setStatus("已完整加载 " + result.records.length + " 条 PR，共 " + result.pageCount + " 页；支持包含/排除筛选，→ 数字为下次点击后的条数", "complete");
    } catch (error) {
      if (requestGeneration !== generation) return;
      loading = false;
      restoreNativePage("全量加载失败：" + (error?.message || "未知错误") + "。已恢复 GitCode 原分页。", "error");
    }
  }

  function activeRequestUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.origin !== API_ORIGIN || url.pathname !== API_PATH) return false;
      if (Number(url.searchParams.get("page") || 1) !== 1) return false;
      const requestState = url.searchParams.get("state") || "opened";
      requestTemplates.set(requestState, url.href);
      return !ownRequestUrls.has(url.href) && requestState === getActiveState();
    } catch {
      return false;
    }
  }

  function handleResource(rawUrl) {
    if (!location.pathname.startsWith("/dashboard/pulls")) return;
    if (!activeRequestUrl(rawUrl)) return;
    loadAllPages(rawUrl);
  }

  function ensureActiveDataset() {
    if (!location.pathname.startsWith("/dashboard/pulls")) return;
    const state = getActiveState();
    if (loadedState === state && loadedRequestKey) return;
    const template = requestTemplates.get(state) || requestTemplates.values().next().value;
    if (!template) return;
    const url = new URL(template);
    url.searchParams.set("state", state);
    url.searchParams.set("page", "1");
    url.searchParams.set("per_page", String(PAGE_SIZE));
    loadAllPages(url.href);
  }

  function handleRouteChange() {
    setTimeout(() => {
      scheduleChrome();
      ensureActiveDataset();
    }, 0);
  }

  function syncChrome() {
    chromeQueued = false;
    if (!location.pathname.startsWith("/dashboard/pulls")) {
      themeObserver?.disconnect();
      themeTargets = [];
      document.getElementById(TOOLBAR_ID)?.remove();
      for (const node of document.querySelectorAll("." + LAYOUT_CLASS)) node.classList.remove(LAYOUT_CLASS);
      document.getElementById(STATUS_ID)?.remove();
      getList()?.classList.remove(LIST_LOADING_CLASS);
      document.querySelector(".issue-pagination")?.classList.remove(PAGER_HIDDEN_CLASS);
      for (const row of document.querySelectorAll(".list-item--pull." + HIDDEN_CLASS)) row.classList.remove(HIDDEN_CLASS);
      return;
    }

    ensureControls();
    if (!loading && loadedRequestKey && loadedState !== getActiveState()) ensureActiveDataset();
    if (!loading && loadedRequestKey && loadedState === getActiveState()) {
      document.querySelector(".issue-pagination")?.classList.add(PAGER_HIDDEN_CLASS);
    }
  }

  function scheduleChrome() {
    if (chromeQueued) return;
    chromeQueued = true;
    requestAnimationFrame(syncChrome);
  }

  function start() {
    requestObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) handleResource(entry.name);
    });
    requestObserver.observe({type:"resource",buffered:true});
    const initialEntries = performance.getEntriesByType("resource");
    for (const entry of initialEntries) handleResource(entry.name);
    domObserver = new MutationObserver(scheduleChrome);
    domObserver.observe(document.documentElement, {childList:true,subtree:true,characterData:true});
    document.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".pd-pulls .collab-status-tabs [role='tab']")) handleRouteChange();
    });
    window.addEventListener("popstate", handleRouteChange);
    systemTheme.addEventListener("change", scheduleChrome);
    document.addEventListener("load", (event) => {
      if (event.target instanceof HTMLLinkElement && event.target.relList.contains("stylesheet")) scheduleChrome();
    }, true);
    document.addEventListener("transitionend", (event) => {
      if (themeTargets.includes(event.target) && ["background", "background-color", "color"].includes(event.propertyName)) scheduleChrome();
    });
    syncChrome();
  }

  start();
})();
