// ==UserScript==
// @name         GitCode PR Dashboard: All Pages + Labels
// @namespace    https://github.com/KaranocaVe/gitcode-pr-dashboard-all-labels-userscript
// @version      1.7.0
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

  const VERSION = "1.7.0";
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
    label: {title:"标签", description:"标签", selected:selectedLabels, excluded:excludedLabels},
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
  let sizeObserver;
  let sizedToolbar = null;
  let optionQuery = "";
  const expandedFilters = new Set();
  let themeTargets = [];
  let colorContext = null;
  let templateRow = null;
  let labelTemplate = null;
  let activeRequestKey = "";
  let loadedRequestKey = "";
  let loadedState = "";
  let loadedRecords = [];
  let lastStatusMessage = "等待列表…";
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
      .${LAYOUT_CLASS}{display:flex!important;flex-direction:row!important;flex-wrap:wrap!important;align-items:center;gap:12px;min-width:0}
      .${LAYOUT_CLASS}>*{flex:0 0 100%;min-width:0;max-width:100%;box-sizing:border-box}
      .${LAYOUT_CLASS}>.collab-status-tabs{flex:0 1 auto!important;width:auto!important;min-width:0!important;max-width:100%!important}
      .${LAYOUT_CLASS}>#${TOOLBAR_ID}{flex:0 0 100%!important;width:100%!important;min-width:0!important;max-width:100%!important}
      #${TOOLBAR_ID}{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;margin:0;padding:10px 12px;border:1px solid var(--gcpr-border);border-radius:9px;background:var(--gcpr-bg);color:var(--gcpr-text);font-size:12px}
      #${TOOLBAR_ID} [hidden]{display:none!important}
      #${TOOLBAR_ID} .gcpr-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--gcpr-border);min-width:0}
      #${TOOLBAR_ID} .gcpr-bar-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}
      #${TOOLBAR_ID} .gcpr-option-search{margin-left:auto;width:210px;min-width:100px;max-width:32%;box-sizing:border-box;border:1px solid var(--gcpr-border);border-radius:6px;padding:5px 8px;background:transparent;color:var(--gcpr-text);font:inherit;line-height:18px}
      #${TOOLBAR_ID} .gcpr-option-search::placeholder{color:var(--gcpr-muted);opacity:.8}
      #${TOOLBAR_ID} .gcpr-filter-strip{display:grid;grid-template-columns:46px minmax(0,1fr) auto;align-items:start;gap:8px;min-width:0}
      #${TOOLBAR_ID} .gcpr-filter-heading{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding-top:3px;color:var(--gcpr-muted);font-weight:600;line-height:16px}
      #${TOOLBAR_ID} .gcpr-filter-heading>span+span{font-size:10px;font-weight:400;opacity:.75;font-variant-numeric:tabular-nums;line-height:12px}
      #${TOOLBAR_ID} .gcpr-filter-items{display:flex;align-items:center;gap:5px;min-width:0;overflow-x:auto;overflow-y:hidden;padding:3px;scrollbar-width:thin;scrollbar-color:var(--gcpr-border) transparent}
      #${TOOLBAR_ID} .gcpr-filter-strip[data-expanded="true"] .gcpr-filter-items{flex-wrap:wrap;max-height:192px;overflow-x:hidden;overflow-y:auto;align-content:flex-start}
      #${TOOLBAR_ID} .gcpr-filter-actions{display:flex;align-items:center;gap:3px;padding-top:3px}
      #${TOOLBAR_ID} .gcpr-filter-pill{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;max-width:min(270px,100%);min-height:28px;box-sizing:border-box;border:1px solid transparent;border-radius:6px;padding:3px 7px;background:var(--gcpr-hover);color:var(--gcpr-text);font:inherit;line-height:18px;white-space:nowrap;cursor:pointer}
      #${TOOLBAR_ID} .gcpr-filter-pill[data-state="neutral"]:hover:not(:disabled){border-color:var(--gcpr-hover-border)}
      #${TOOLBAR_ID} .gcpr-filter-pill[data-state="include"]{border-color:var(--gcpr-include-border);background:var(--gcpr-include-bg);color:var(--gcpr-include-text)}
      #${TOOLBAR_ID} .gcpr-filter-pill[data-state="exclude"]{border-color:var(--gcpr-exclude-border);background:var(--gcpr-exclude-bg);color:var(--gcpr-exclude-text)}
      #${TOOLBAR_ID} .gcpr-filter-pill[data-state="exclude"] .gcpr-filter-name{text-decoration:line-through}
      #${TOOLBAR_ID} :is(button,input,summary):focus-visible{outline:2px solid var(--gcpr-focus);outline-offset:1px}
      #${TOOLBAR_ID} button:disabled{opacity:.5;cursor:not-allowed}
      #${TOOLBAR_ID} .gcpr-filter-state{flex:0 0 10px;text-align:center;font-weight:700}
      #${TOOLBAR_ID} .gcpr-filter-pill[data-state="neutral"] .gcpr-filter-state{opacity:.35;font-size:10px}
      #${TOOLBAR_ID} .gcpr-filter-name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis}
      #${TOOLBAR_ID} .gcpr-filter-pill[data-filter="repository"] .gcpr-filter-name{display:flex}
      #${TOOLBAR_ID} .gcpr-repo-namespace{max-width:100px;overflow:hidden;text-overflow:ellipsis;opacity:.65}
      #${TOOLBAR_ID} .gcpr-repo-name{min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:500}
      #${TOOLBAR_ID} .gcpr-filter-count{flex:0 0 auto;font-size:10px;opacity:.65;font-variant-numeric:tabular-nums}
      #${TOOLBAR_ID} :is(.gcpr-filter-clear,.gcpr-filter-more,.gcpr-reset,.gcpr-retry,.gcpr-export-json){flex:0 0 auto;border:1px solid transparent;border-radius:5px;padding:4px 7px;background:transparent;color:var(--gcpr-muted);font:inherit;line-height:18px;white-space:nowrap;cursor:pointer}
      #${TOOLBAR_ID} :is(.gcpr-filter-clear,.gcpr-filter-more,.gcpr-reset,.gcpr-retry,.gcpr-export-json):hover:not(:disabled){background:var(--gcpr-hover);color:var(--gcpr-text)}
      #${TOOLBAR_ID} .gcpr-filter-clear{width:26px;padding:3px;font-size:17px}
      #${TOOLBAR_ID} .gcpr-filter-more{font-size:11px;padding:3px 5px}
      #${TOOLBAR_ID} .gcpr-export-json{border-color:var(--gcpr-border);color:var(--gcpr-text)}
      #${TOOLBAR_ID} .gcpr-help{position:relative;flex:0 0 auto}
      #${TOOLBAR_ID} .gcpr-help>summary{display:grid;place-items:center;box-sizing:border-box;width:28px;height:28px;border-radius:5px;list-style:none;color:var(--gcpr-muted);cursor:pointer}
      #${TOOLBAR_ID} .gcpr-help>summary::-webkit-details-marker{display:none}
      #${TOOLBAR_ID} .gcpr-help>summary:hover{background:var(--gcpr-hover);color:var(--gcpr-text)}
      #${TOOLBAR_ID} .gcpr-help-content{position:absolute;right:0;top:calc(100% + 6px);z-index:20;width:max-content;max-width:min(330px,80vw);box-sizing:border-box;padding:10px 12px;border:1px solid var(--gcpr-border);border-radius:7px;background:var(--gcpr-bg);color:var(--gcpr-text);line-height:1.8;box-shadow:0 4px 16px #0002}
      #${TOOLBAR_ID} .gcpr-filter-empty{color:var(--gcpr-muted);line-height:28px}
      #${STATUS_ID}{display:flex;align-items:center;gap:7px;flex:0 1 auto;min-width:90px;white-space:nowrap;font-size:12px;line-height:28px;color:var(--gcpr-muted);font-variant-numeric:tabular-nums}
      #${STATUS_ID}::before{content:"";width:5px;height:5px;flex:0 0 auto;border-radius:50%;background:currentColor;opacity:.6}
      #${STATUS_ID}[data-kind="complete"]{color:var(--gcpr-text);font-weight:500}
      #${STATUS_ID}[data-kind="error"]{color:var(--gcpr-exclude-text)}
      #${STATUS_ID}[data-kind="loading"]::before{animation:gcpr-pulse 1s ease-in-out infinite alternate}
      @keyframes gcpr-pulse{to{opacity:.15}}
      @media(prefers-reduced-motion:reduce){#${STATUS_ID}::before{animation:none!important}}
      @media(max-width:700px){
        #${TOOLBAR_ID}{padding:9px;gap:6px}
        #${TOOLBAR_ID} .gcpr-bar{flex-wrap:wrap;gap:6px}
        #${TOOLBAR_ID} .gcpr-bar-actions{margin-left:auto}
        #${TOOLBAR_ID} .gcpr-option-search{order:3;max-width:none;width:100%;margin-left:0}
        #${TOOLBAR_ID} .gcpr-filter-strip{grid-template-columns:36px minmax(0,1fr) auto;gap:5px}
        #${TOOLBAR_ID} .gcpr-filter-pill{max-width:min(240px,100%)}
        #${TOOLBAR_ID} .gcpr-repo-namespace{max-width:65px}
      }
      .pd-pulls .list-item--pull.${HIDDEN_CLASS}{display:none!important}
      .pd-pulls .issue-pagination.${PAGER_HIDDEN_CLASS}{display:none!important}
      .pd-pulls .list-surface.${LIST_LOADING_CLASS}{display:none!important}
      .pd-pulls .gcpr-result-empty{padding:40px 12px;text-align:center;opacity:.65;font-size:13px}
      .pd-pulls .gcpr-result-empty[hidden]{display:none!important}
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
  }

  function updateToolbarSummary() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    const status = document.getElementById(STATUS_ID);
    if (!toolbar || !status) return;
    const ready = canExportCurrentList();
    const text = ready
      ? filteredRecords().length.toLocaleString() + " / " + loadedRecords.length.toLocaleString() + " 条"
      : lastStatusKind === "error" ? "加载失败" : lastStatusMessage;
    if (status.textContent !== text) status.textContent = text;
    const kind = ready ? "complete" : loading ? "loading" : lastStatusKind;
    if (status.dataset.kind !== kind) status.dataset.kind = kind;
    status.dataset.version = VERSION;
    const title = ready ? "匹配 / 已加载 PR" : lastStatusMessage;
    if (status.title !== title) status.title = title;
    const active = Object.values(filters).some((filter) => filter.selected.size || filter.excluded.size);
    const reset = toolbar.querySelector(".gcpr-reset");
    if (reset && reset.hidden !== !active) reset.hidden = !active;
    const retry = toolbar.querySelector(".gcpr-retry");
    const failed = lastStatusKind === "error" && !loading;
    if (retry && retry.hidden !== !failed) retry.hidden = !failed;
  }

  function createToolbarHeader() {
    const bar = document.createElement("div");
    bar.className = "gcpr-bar";
    const status = document.createElement("span");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const search = document.createElement("input");
    search.type = "search";
    search.className = "gcpr-option-search";
    search.placeholder = "查找标签或仓库";
    search.setAttribute("aria-label", "查找筛选项，不改变 PR 筛选条件");
    search.title = "仅查找筛选项；已选条件始终显示";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.value = optionQuery;
    const actions = document.createElement("div");
    actions.className = "gcpr-bar-actions";
    for (const [className, text, title] of [
      ["gcpr-reset", "重置", "清除全部筛选"],
      ["gcpr-retry", "重试", "重新加载当前列表"],
      ["gcpr-export-json", "导出 JSON", "导出筛选后的 PR"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = text;
      button.title = title;
      if (className !== "gcpr-export-json") button.hidden = true;
      else button.disabled = true;
      actions.append(button);
    }
    const help = document.createElement("details");
    help.className = "gcpr-help";
    const summary = document.createElement("summary");
    summary.textContent = "?";
    summary.setAttribute("aria-label", "筛选帮助");
    summary.title = "筛选帮助";
    const content = document.createElement("div");
    content.className = "gcpr-help-content";
    for (const line of ["点击循环：不限 → 包含 → 排除 → 不限", "Shift + 点击：直接排除 / 取消排除", "→ 数字：普通点击后的结果数", "多个标签需同时具有；多个仓库任选其一"]) {
      const row = document.createElement("div");
      row.textContent = line;
      content.append(row);
    }
    help.append(summary, content);
    actions.append(help);
    bar.append(status, search, actions);
    return bar;
  }

  function createFilterStrip(kind) {
    const filter = filters[kind];
    const strip = document.createElement("div");
    strip.className = "gcpr-filter-strip gcpr-" + kind + "-strip";
    strip.dataset.filter = kind;
    strip.dataset.expanded = String(expandedFilters.has(kind));
    const heading = document.createElement("div");
    heading.className = "gcpr-filter-heading";
    const title = document.createElement("span");
    title.textContent = filter.title;
    const count = document.createElement("span");
    count.className = "gcpr-" + kind + "-loaded";
    heading.append(title, count);
    const items = document.createElement("div");
    items.className = "gcpr-filter-items gcpr-" + kind + "-items";
    items.id = TOOLBAR_ID + "-" + kind;
    items.setAttribute("role", "group");
    items.setAttribute("aria-label", "按" + filter.title + "筛选");
    const actions = document.createElement("div");
    actions.className = "gcpr-filter-actions";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "gcpr-filter-more";
    more.dataset.filter = kind;
    more.setAttribute("aria-controls", items.id);
    more.hidden = true;
    const clear = document.createElement("button");
    clear.className = "gcpr-filter-clear gcpr-" + kind + "-clear";
    clear.type = "button";
    clear.dataset.filter = kind;
    clear.setAttribute("aria-label", "清除" + filter.title + "筛选");
    clear.title = "清除" + filter.title + "筛选";
    clear.hidden = true;
    clear.textContent = "×";
    actions.append(more, clear);
    strip.append(heading, items, actions);
    return strip;
  }

  function updateOverflow() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;
    for (const kind of Object.keys(filters)) {
      const strip = toolbar.querySelector(".gcpr-" + kind + "-strip");
      const items = strip?.querySelector(".gcpr-filter-items");
      const more = strip?.querySelector(".gcpr-filter-more");
      if (!items || !more) continue;
      const expanded = expandedFilters.has(kind);
      const value = String(expanded);
      if (strip.dataset.expanded !== value) strip.dataset.expanded = value;
      const overflow = items.scrollWidth > items.clientWidth + 2;
      const text = expanded ? "收起" : "展开";
      if (more.textContent !== text) more.textContent = text;
      const hidden = !expanded && !overflow;
      if (more.hidden !== hidden) more.hidden = hidden;
      if (more.getAttribute("aria-expanded") !== value) more.setAttribute("aria-expanded", value);
      const label = (expanded ? "收起" : "展开") + filters[kind].title;
      if (more.getAttribute("aria-label") !== label) more.setAttribute("aria-label", label);
    }
  }

  function applyOptionSearch() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;
    const query = normalize(optionQuery);
    const focused = document.activeElement;
    for (const kind of Object.keys(filters)) {
      const items = toolbar.querySelector(".gcpr-" + kind + "-items");
      const count = toolbar.querySelector(".gcpr-" + kind + "-loaded");
      if (!items || !count) continue;
      const pills = [...items.querySelectorAll(".gcpr-filter-pill")];
      let visible = 0;
      for (const pill of pills) {
        const show = !query || pill.dataset.search.includes(query) || pill.dataset.state !== "neutral";
        if (pill.hidden !== !show) pill.hidden = !show;
        if (show) visible += 1;
      }
      const label = query ? visible + "/" + pills.length : String(pills.length);
      if (count.textContent !== label) count.textContent = label;
      const title = query ? "显示 / 全部选项（含已选条件）" : pills.length + " 个" + filters[kind].title;
      if (count.title !== title) count.title = title;
      let empty = items.querySelector(".gcpr-search-empty");
      if (pills.length && !empty) {
        empty = document.createElement("span");
        empty.className = "gcpr-filter-empty gcpr-search-empty";
        empty.textContent = "无匹配项";
        items.append(empty);
      }
      if (empty) {
        const hidden = visible > 0 || !query || !pills.length;
        if (empty.hidden !== hidden) empty.hidden = hidden;
      }
    }
    if (focused?.matches(".gcpr-filter-pill") && focused.hidden) toolbar.querySelector(".gcpr-option-search").focus();
    updateOverflow();
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
      toolbar.setAttribute("aria-label", "PR 筛选");
      toolbar.dataset.version = VERSION;
      rebuilt = true;
    }
    let header = toolbar.querySelector(".gcpr-bar");
    if (!header || !header.querySelector("#" + STATUS_ID) || !header.querySelector(".gcpr-option-search") || !header.querySelector(".gcpr-export-json")) {
      header?.remove();
      header = createToolbarHeader();
      toolbar.prepend(header);
      rebuilt = true;
    } else if (toolbar.firstElementChild !== header) toolbar.prepend(header);
    for (const kind of Object.keys(filters)) {
      const strip = toolbar.querySelector(".gcpr-" + kind + "-strip");
      if (!strip || !strip.querySelector(".gcpr-" + kind + "-items") ||
          !strip.querySelector(".gcpr-" + kind + "-loaded") || !strip.querySelector(".gcpr-" + kind + "-clear") ||
          !strip.querySelector(".gcpr-filter-more")) {
        strip?.remove();
        toolbar.append(createFilterStrip(kind));
        rebuilt = true;
      }
    }
    const labelStrip = toolbar.querySelector(".gcpr-label-strip");
    const repoStrip = toolbar.querySelector(".gcpr-repository-strip");
    if (labelStrip.previousElementSibling !== header) header.insertAdjacentElement("afterend", labelStrip);
    if (repoStrip.previousElementSibling !== labelStrip) labelStrip.insertAdjacentElement("afterend", repoStrip);
    if (toolbar.previousElementSibling !== tabs || toolbar.parentElement !== layout) tabs.insertAdjacentElement("afterend", toolbar);

    if (toolbar.dataset.gcprEventsBound !== "true") {
      toolbar.dataset.gcprEventsBound = "true";
      toolbar.addEventListener("input", (event) => {
        if (!event.target.matches(".gcpr-option-search")) return;
        optionQuery = event.target.value;
        applyOptionSearch();
      });
      toolbar.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        const help = toolbar.querySelector(".gcpr-help");
        if (event.target.matches(".gcpr-option-search") && optionQuery) {
          optionQuery = "";
          event.target.value = "";
          applyOptionSearch();
          event.preventDefault();
        } else if (help?.open) {
          help.open = false;
          help.querySelector("summary").focus();
          event.preventDefault();
        }
      });
      toolbar.addEventListener("click", (event) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest(".gcpr-export-json")) { exportCurrentList(); return; }
        if (event.target.closest(".gcpr-reset")) {
          for (const filter of Object.values(filters)) { filter.selected.clear(); filter.excluded.clear(); }
          optionQuery = "";
          toolbar.querySelector(".gcpr-option-search").value = "";
          renderFilterPills(loadedRecords);
          applyFilters();
          toolbar.querySelector(".gcpr-option-search").focus();
          return;
        }
        if (event.target.closest(".gcpr-retry")) { ensureActiveDataset(true); return; }
        const more = event.target.closest(".gcpr-filter-more");
        if (more) {
          const kind = more.dataset.filter;
          if (expandedFilters.has(kind)) expandedFilters.delete(kind);
          else expandedFilters.add(kind);
          updateOverflow();
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
          toolbar.querySelector(".gcpr-option-search").focus();
          return;
        }
        const pill = event.target.closest(".gcpr-filter-pill");
        if (!pill || pill.disabled) return;
        const filter = filters[pill.dataset.filter];
        if (!filter) return;
        const value = pill.dataset.value;
        const state = filterState(filter, value);
        if (!canExportCurrentList() && state === "neutral") return;
        const next = event.detail > 0 && event.shiftKey ? (state === "exclude" ? "neutral" : "exclude") : nextStates[state];
        setFilterState(filter, value, next);
        renderFilterPills(loadedRecords);
        applyFilters();
      });
    }
    if (sizedToolbar !== toolbar) {
      sizeObserver?.disconnect();
      if (!sizeObserver) sizeObserver = new ResizeObserver(scheduleChrome);
      sizeObserver.observe(toolbar);
      sizedToolbar = toolbar;
    }
    if (rebuilt || toolbar.dataset.gcprFiltersKey !== loadedRequestKey) renderFilterPills(loadedRecords);
    updateExportButton();
    updateOverflow();
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

      if (!entries.length) {
        const message = loading ? "加载中…" : "暂无选项";
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
          const description = name + " · " + stateNames[state] + " → " + stateNames[next] + (ready
            ? " · " + count.toLocaleString() + " 条（原始 " + total.toLocaleString() + "）"
            : loading ? " · 加载中" : lastStatusKind === "error" ? " · 加载失败，请重试" : " · 等待加载");
          if (pill.title !== description) pill.title = description;
          if (pill.getAttribute("aria-label") !== description) pill.setAttribute("aria-label", description);
          const marker = pill.querySelector(".gcpr-filter-state");
          if (marker.textContent !== stateSymbols[state]) marker.textContent = stateSymbols[state];
          const text = pill.querySelector(".gcpr-filter-name");
          const slash = kind === "repository" ? name.lastIndexOf("/") : -1;
          if (text.dataset.name !== name) {
            if (slash >= 0) {
              const namespace = document.createElement("span");
              namespace.className = "gcpr-repo-namespace";
              namespace.textContent = name.slice(0, slash + 1);
              const repository = document.createElement("span");
              repository.className = "gcpr-repo-name";
              repository.textContent = name.slice(slash + 1);
              text.replaceChildren(namespace, repository);
            } else text.textContent = name;
            text.dataset.name = name;
          }
          const search = normalize(name);
          if (pill.dataset.search !== search) pill.dataset.search = search;
          const badge = pill.querySelector(".gcpr-filter-count");
          const countText = ready ? "→" + count.toLocaleString() : "—";
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
    applyOptionSearch();
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
    const text = "导出 JSON";
    const title = ready ? "导出筛选后的 PR" : "加载完成后可导出";
    if (button.disabled !== !ready) button.disabled = !ready;
    if (button.textContent !== text) button.textContent = text;
    if (button.title !== title) button.title = title;
    updateToolbarSummary();
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
    const empty = list.querySelector(".gcpr-result-empty");
    if (empty) {
      const message = loadedRecords.length ? "没有符合条件的 PR" : "暂无 PR";
      if (empty.textContent !== message) empty.textContent = message;
      if (empty.hidden !== (matchingKeys.size > 0)) empty.hidden = matchingKeys.size > 0;
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
    const empty = document.createElement("div");
    empty.className = "gcpr-result-empty";
    empty.hidden = true;
    fragment.append(empty);
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
      setStatus(attempt ? "列表有变化，重新读取…" : "读取第 1 页…", "loading");
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
        setStatus("加载 " + completed + "/" + pageCount + " 页", "loading");
        await delay(120);
      }

      if (requestGeneration !== generation) return null;
      setStatus("校验列表…", "loading");
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
    setLoadingUi("读取列表…");

    try {
      const result = await fetchDataset(base.href, requestGeneration, currentController.signal);
      if (!result || requestGeneration !== generation) return;
      loadedRequestKey = key;
      loadedState = base.searchParams.get("state") || getActiveState();
      renderRecords(result.records, key);
      loading = false;
      setStatus("已加载 " + result.records.length + " 条", "complete");
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

  function ensureActiveDataset(force = false) {
    if (!location.pathname.startsWith("/dashboard/pulls")) return;
    const state = getActiveState();
    if (!force && loadedState === state && loadedRequestKey) return;
    const template = requestTemplates.get(state) || requestTemplates.values().next().value;
    if (!template) return;
    const url = new URL(template);
    url.searchParams.set("state", state);
    url.searchParams.set("page", "1");
    url.searchParams.set("per_page", String(PAGE_SIZE));
    if (force) loadedRequestKey = "";
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
      sizeObserver?.disconnect();
      sizedToolbar = null;
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
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(".pd-pulls .collab-status-tabs [role='tab']")) handleRouteChange();
      const help = document.querySelector("#" + TOOLBAR_ID + " .gcpr-help");
      if (help?.open && !help.contains(event.target)) help.open = false;
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
