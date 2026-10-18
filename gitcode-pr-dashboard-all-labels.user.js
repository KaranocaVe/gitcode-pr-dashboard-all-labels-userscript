// ==UserScript==
// @name         GitCode PR Dashboard: All Pages + Labels
// @namespace    https://github.com/KaranocaVe/gitcode-pr-dashboard-all-labels-userscript
// @version      1.1.0
// @updateURL    https://raw.githubusercontent.com/KaranocaVe/gitcode-pr-dashboard-all-labels-userscript/main/gitcode-pr-dashboard-all-labels.user.js
// @downloadURL  https://raw.githubusercontent.com/KaranocaVe/gitcode-pr-dashboard-all-labels-userscript/main/gitcode-pr-dashboard-all-labels.user.js
// @description  Load all GitCode pull requests in the selected status and filter them by counted labels.
// @match        https://gitcode.com/dashboard/pulls*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  if (window.__gcprAllPagesLabelsInstalled) return;
  window.__gcprAllPagesLabelsInstalled = true;

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

  let requestObserver;
  let domObserver;
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
    style.textContent =
      "#" + TOOLBAR_ID + "{display:flex;align-items:center;gap:14px;width:100%;min-width:0;box-sizing:border-box;margin:0 0 8px}" +
      "#" + TOOLBAR_ID + " .collab-status-tabs{flex:0 0 auto;min-width:max-content}" +
      "#" + TOOLBAR_ID + " .gcpr-label-strip{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;overflow:hidden}" +
      "#" + TOOLBAR_ID + " .gcpr-label-heading{display:flex;align-items:center;gap:6px;flex:0 0 auto;white-space:nowrap;font-size:12px;color:var(--theme-text-weak,#656d76)}" +
      "#" + TOOLBAR_ID + " .gcpr-label-items{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;padding:3px 1px;scrollbar-width:thin}" +
      "#" + TOOLBAR_ID + " .gcpr-label-pill{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;max-width:240px;border:1px solid var(--theme-border,#d0d7de);border-radius:999px;padding:4px 9px;background:var(--theme-bg,#fff);color:var(--theme-text,#24292f);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}" +
      "#" + TOOLBAR_ID + " .gcpr-label-pill:hover{border-color:#8ab4f8;background:#f6f9ff}" +
      "#" + TOOLBAR_ID + " .gcpr-label-pill[aria-pressed='true']{border-color:#2865e0;background:#e8f0fe;color:#174ea6}" +
      "#" + TOOLBAR_ID + " .gcpr-label-name{overflow:hidden;text-overflow:ellipsis}" +
      "#" + TOOLBAR_ID + " .gcpr-label-count{font-size:11px;font-weight:700;opacity:.9}" +
      "#" + TOOLBAR_ID + " .gcpr-label-clear{flex:0 0 auto;border:0;background:transparent;color:var(--theme-text-weak,#656d76);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}" +
      "#" + TOOLBAR_ID + " .gcpr-label-clear[hidden]{display:none}" +
      "#" + STATUS_ID + "{margin:0 0 10px;color:var(--theme-text-weak,#656d76);font-size:12px}" +
      ".pd-pulls .list-item--pull." + HIDDEN_CLASS + "{display:none!important}" +
      ".pd-pulls .issue-pagination." + PAGER_HIDDEN_CLASS + "{display:none!important}" +
      ".pd-pulls .list-surface." + LIST_LOADING_CLASS + "{display:none!important}" +
      "@media(max-width:900px){#" + TOOLBAR_ID + "{align-items:flex-start;flex-direction:column;gap:8px}#" + TOOLBAR_ID + " .gcpr-label-strip{width:100%}}";
    document.head.append(style);
  }

  function setStatus(message, kind) {
    lastStatusMessage = message;
    lastStatusKind = kind || "info";
    const status = document.getElementById(STATUS_ID);
    if (!status) return;
    status.textContent = lastStatusMessage;
    status.dataset.kind = lastStatusKind;
  }

  function createLabelStrip() {
    const strip = document.createElement("div");
    strip.className = "gcpr-label-strip";

    const heading = document.createElement("div");
    heading.className = "gcpr-label-heading";
    const title = document.createElement("span");
    title.textContent = "Label";
    const loaded = document.createElement("span");
    loaded.className = "gcpr-label-loaded";
    heading.append(title, loaded);

    const items = document.createElement("div");
    items.className = "gcpr-label-items";
    items.setAttribute("role", "group");
    items.setAttribute("aria-label", "PR label 及命中数量");

    const clear = document.createElement("button");
    clear.className = "gcpr-label-clear";
    clear.type = "button";
    clear.setAttribute("aria-label", "清除所有 label 筛选");
    clear.hidden = true;
    clear.textContent = "清除";

    strip.append(heading, items, clear);
    return strip;
  }

  function ensureControls() {
    const main = getMain();
    const tabs = main?.querySelector(".collab-status-tabs");
    if (!main || !tabs) return null;
    addStyles();

    let toolbar = main.querySelector("#" + TOOLBAR_ID);
    let rebuilt = false;
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.id = TOOLBAR_ID;
      toolbar.setAttribute("role", "group");
      toolbar.setAttribute("aria-label", "按 label 筛选完整 PR 列表");
      main.insertBefore(toolbar, tabs);
      rebuilt = true;
    }

    const labelStrip = toolbar.querySelector(".gcpr-label-strip");
    if (!labelStrip || !labelStrip.querySelector(".gcpr-label-items") ||
        !labelStrip.querySelector(".gcpr-label-loaded") || !labelStrip.querySelector(".gcpr-label-clear")) {
      labelStrip?.remove();
      toolbar.append(createLabelStrip());
      rebuilt = true;
    }

    if (tabs.parentElement !== toolbar) toolbar.prepend(tabs);

    if (toolbar.dataset.gcprEventsBound !== "true") {
      toolbar.dataset.gcprEventsBound = "true";
      toolbar.addEventListener("click", (event) => {
        const clear = event.target.closest(".gcpr-label-clear");
        if (clear) {
          selectedLabels.clear();
          renderLabelPills(loadedRecords);
          applyLabelFilter();
          return;
        }
        const pill = event.target.closest(".gcpr-label-pill");
        if (!pill) return;
        const label = pill.getAttribute("data-label");
        if (selectedLabels.has(label)) selectedLabels.delete(label);
        else selectedLabels.add(label);
        renderLabelPills(loadedRecords);
        applyLabelFilter();
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

    if (rebuilt || toolbar.dataset.gcprLabelsKey !== loadedRequestKey) {
      renderLabelPills(loadedRecords);
      if (loadedRequestKey && loadedState === getActiveState()) {
        setStatus(lastStatusMessage, lastStatusKind);
      }
    }
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
      for (const label of record.labels) counts.set(label.name, (counts.get(label.name) || 0) + 1);
    }
    return [...counts].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function renderLabelPills(records) {
    const toolbar = document.getElementById(TOOLBAR_ID);
    const items = toolbar?.querySelector(".gcpr-label-items");
    const loaded = toolbar?.querySelector(".gcpr-label-loaded");
    const clear = toolbar?.querySelector(".gcpr-label-clear");
    if (!toolbar || !items || !loaded || !clear) return;

    const labels = summarizeLabels(records || []);
    toolbar.dataset.gcprLabelsKey = loadedRequestKey;
    loaded.textContent = records.length ? "当前 " + records.length + " 条" : "暂无 PR";
    items.replaceChildren();

    if (!labels.length) {
      const empty = document.createElement("span");
      empty.className = "gcpr-label-name";
      empty.textContent = loading ? "正在读取 label…" : "当前列表没有 label";
      items.append(empty);
    } else {
      for (const [name, count] of labels) {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "gcpr-label-pill";
        pill.setAttribute("data-label", name);
        pill.setAttribute("aria-pressed", String(selectedLabels.has(name)));
        pill.setAttribute("aria-label", name + "，当前完整列表中 " + count + " 条 PR");
        pill.title = name + " · 当前完整列表中 " + count + " 条 PR";
        const labelText = document.createElement("span");
        labelText.className = "gcpr-label-name";
        labelText.textContent = name;
        const labelCount = document.createElement("span");
        labelCount.className = "gcpr-label-count";
        labelCount.textContent = String(count);
        pill.append(labelText, labelCount);
        items.append(pill);
      }
    }
    clear.hidden = selectedLabels.size === 0;
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
      simple.append(title);
      simple.dataset.gcprGenerated = "true";
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

  function applyLabelFilter() {
    const list = getList();
    if (!list) return;
    for (const row of list.querySelectorAll(".list-item--pull")) {
      const labels = new Set([...row.querySelectorAll(".g-label-tag-text")].map((node) => normalize(node.getAttribute("title") || node.textContent)));
      const matches = [...selectedLabels].every((label) => labels.has(normalize(label)));
      row.classList.toggle(HIDDEN_CLASS, !matches);
    }
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
    renderLabelPills(records);
    applyLabelFilter();
  }

  function setLoadingUi(message) {
    ensureControls();
    setStatus(message, "loading");
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
      setStatus("已完整加载 " + result.records.length + " 条 PR，共 " + result.pageCount + " 页；label 数量按完整列表统计", "complete");
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
      document.getElementById(TOOLBAR_ID)?.remove();
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
    syncChrome();
  }

  start();
})();
