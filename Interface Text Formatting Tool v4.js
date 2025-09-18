/* eslint semi: ["error", "always"] */
import config from "./styles";
const DEBUG_IF = true; // flip to false to silence logs
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) + "ms").padStart(6, " ");
const dlog  = (...a) => DEBUG_IF && console.log("[IF]", stamp(), ...a);
const dwarn = (...a) => DEBUG_IF && console.warn("[IF]", stamp(), ...a);
const derr  = (...a) => DEBUG_IF && console.error("[IF]", stamp(), ...a);
function timed(label, fn) {
  const start = performance.now();
  try { return fn(); }
  finally {
    const ms = (performance.now() - start).toFixed(1);
    dlog(`${label} took ${ms}ms`);
  }
}
const CN_RE = /\b[A-Z]{2,4}-\d{3,}\b/;
function* allRoots(rootDoc) {
  function* walk(node) {
    if (node) yield node;
    const elements = node?.querySelectorAll ? Array.from(node.querySelectorAll("*")) : [];
    for (const el of elements) {
      if (el.shadowRoot) {
        yield* walk(el.shadowRoot);
      }
    }
  }
  yield* walk(rootDoc);
  try {
    const iframes = Array.from(rootDoc.querySelectorAll("iframe"));
    for (const f of iframes) {
      try {
        const idoc = f.contentDocument || f.contentWindow?.document;
        if (idoc) yield* walk(idoc);
      } catch(_) {}
    }
  } catch(_) {}
}
function pullText(el) {
  const t = (el?.textContent || el?.innerText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')          // nbsp -> space
    .replace(/[ \t]+\n/g, '\n')       // trailing ws before newline
    .replace(/[ \t]{2,}/g, ' ')       // collapse runs of spaces/tabs
    .trim();
  return t;
}
function htmlToPlain(html) {
  if (!html) return '';
  let s = html;
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/<(?:p|div|section|article|h[1-6])\b[^>]*>/gi, '\n')
       .replace(/<\/(?:p|div|section|article|h[1-6])>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ').replace(/<\/li>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&#10;?/g, '\n');
  s = s.replace(/[ \t]+\n/g, '\n')
       .replace(/\n{3,}/g, '\n\n')
       .replace(/[ \t]{2,}/g, ' ')
       .trim();
  return s;
}
function findSourceInfosGrids() {
  const root = top?.document || document;
  const grids = new Set();
  for (const r of allRoots(root)) {
    try {
      r.querySelectorAll('[role="grid"], table[role="grid"]').forEach(g => {
        const label = (g.getAttribute('aria-label') || '').trim();
        if (/^source infos?/i.test(label)) grids.add(g);
      });
      r.querySelectorAll('[role="grid"]').forEach(g => {
        if (grids.has(g)) return;
        const headers = Array.from(g.querySelectorAll('[role="columnheader"], th'))
          .map(h => pullText(h));
        if (headers.some(h => /^source information$/i.test(h))) {
          grids.add(g);
        }
      });
    } catch (_) {}
  }
  dlog("findSourceInfosGrids ->", grids.size, "grid(s)");
  return Array.from(grids);
}
function findValueByLabel(labelRegex) {
  const root = top?.document || document;
  const getRichInnerHTML = el => {
    try {
      const direct = el.innerHTML || "";
      if (direct && /<\w+/i.test(direct)) return direct;
      const sr = el.shadowRoot;
      if (sr) {
        const out =
          sr.querySelector(".slds-rich-text-editor__output") ||
          sr.querySelector("div, span");
        if (out && out.innerHTML) return out.innerHTML;
      }
    } catch(_) {}
    return el.innerHTML || "";
  };
  for (const r of allRoots(root)) {
    try {
      const all = Array.from(r.querySelectorAll("*"));
      const labelNode = all.find(n => labelRegex.test((n.textContent || '').trim()));
      if (!labelNode) continue;
      const container = labelNode.closest('records-record-layout-item, lightning-layout, div, section') || labelNode.parentElement;
      if (!container) continue;
      const rich =
        container.querySelector('lightning-formatted-rich-text, lightning-output-rich-text, lightning-base-formatted-rich-text');

      if (rich) {
        const html = getRichInnerHTML(rich);
        return { type: 'rich', node: rich, html };
      }
      const txt = container.querySelector('lightning-base-formatted-text, lightning-formatted-text, [data-output-element-id="output-field"]');
      if (txt) return { type: 'text', node: txt };
    } catch (_) {}
  }
  return null;
}
async function readSourceInfoFromDetails() {
  dlog("readSourceInfoFromDetails: ensure Details tab");
  await ensureOnTab('Details', { timeout: 10000 });
  const labeled = await waitFor(
    () => findValueByLabel(/^\s*Source\s*Information\s*$/i),
    { timeout: 6000, label: "waitFor(Source Information field)" }
  );
  if (labeled) {
    if (labeled.type === 'rich') {
      const raw = labeled.html || labeled.node.innerHTML || '';
      const clean = sanitizeRichHTML(raw);
      dlog("readSourceInfoFromDetails -> RICH length:", clean.length);
      return { html: clean, text: "" };
    } else {
      const text = pullText(labeled.node);
      dlog("readSourceInfoFromDetails -> TEXT length:", text.length);
      dlog("readSourceInfoFromDetails -> nothing found");
      return { html: "", text };
    }
  }
  dwarn("readSourceInfoFromDetails: labeled not found, trying fallback scans");
  const root = top?.document || document;
  const tryGetInner = (el) => {
    try {
      if (!el) return '';
      if (el.innerHTML && /<\w+/i.test(el.innerHTML)) return el.innerHTML;
      if (el.shadowRoot) {
        const out =
          el.shadowRoot.querySelector('.slds-rich-text-editor__output') ||
          el.shadowRoot.querySelector('div, span');
        if (out && out.innerHTML) return out.innerHTML;
      }
    } catch(_) {}
    return el?.innerHTML || '';
  };
  for (const r of allRoots(root)) {
    try {
      const container = r.querySelector('records-record-layout-item, records-highlights-details, forcegenerated-adg-rollup_component__recordlayout2');
      if (!container) continue;
      const rich = container.querySelector(
        'lightning-formatted-rich-text, lightning-output-rich-text, lightning-base-formatted-rich-text'
      );
      if (rich) {
        const raw = tryGetInner(rich);
        if (raw) return { html: sanitizeRichHTML(raw), text: "" };
      }
    } catch(_) {}
  }
  for (const r of allRoots(root)) {
    try {
      const txt = r.querySelector('lightning-base-formatted-text, lightning-formatted-text, [data-output-element-id="output-field"]');
      if (txt) return { html: "", text: pullText(txt) };
    } catch(_) {}
  }
  return { html: "", text: "" };
}
async function navigateTo(href) {
  dlog("navigateTo:", href);
  try { 
    const a = document.createElement('a');
    a.href = href;
    const want = a.href;
    if (location.href !== want) location.assign(want);
    else safeClick(a); // fallback
  } catch(_) { location.assign(href); }
  const ok = await waitFor(
    () => /lightning\/r\//i.test(location.href) || document.querySelector('records-record-layout-item'),
    { timeout: 12000, label: "waitFor(record page)" }
  );
  dlog("navigateTo ok?", !!ok, "current:", location.href);
  return !!ok;
}
let __LIST_URL__ = null;
async function goBackToSourceInfoTab() {
  if (__LIST_URL__) {
    dlog("goBack: using stored list url:", __LIST_URL__);
    location.assign(__LIST_URL__);
  } else {
    dlog("goBack: using history.back()");
    history.back();
  }
  await waitFor(() => findSourceInfosGrids().length > 0, { timeout: 12000, label: "waitFor(grid after back)" });
  const onTab = await ensureOnTab('Source Info') || await ensureOnTab('Source Information');
  dlog("ensureOnTab(Source Info) ->", !!onTab);
}
async function goBackToSourceInfoTab() {
  history.back();
  await waitFor(() => findSourceInfosGrids().length > 0, { timeout: 12000 });
  await ensureOnTab('Source Info') || await ensureOnTab('Source Information');
}
function queryDeepForLink(rootNode) {
  for (const n of allRoots(rootNode)) {
    try {
      const a = n.querySelector && n.querySelector('a[href]');
      if (a) return a;
    } catch(_) {}
  }
  return null;
}
function harvestRowsFromGrid(grid) {
  const rows = [];
  const rowEls = grid.querySelectorAll('[role="row"]');
  dlog("harvestRowsFromGrid scanning rows:", rowEls.length);
  let dataRowCounter = 0;
  rowEls.forEach(rowEl => {
    const cells = rowEl.querySelectorAll('td[role="gridcell"]');
    const ariaIdx = parseInt(rowEl.getAttribute('aria-rowindex') || '', 10);
    dataRowCounter += 1;
    const rowIndex = Number.isFinite(ariaIdx) ? ariaIdx : dataRowCounter;
    let sourceText = '';
    let sourceHtml = '';
    let add = null;
    const recordHref = timed("findSourceInfoLinkInRow", () => findSourceInfoLinkInRow(rowEl));
    cells.forEach(td => {
      const label = (td.getAttribute('data-label') || '').trim();
      const key   = (td.getAttribute('data-col-key-value') || '').trim();
      if (/^source information$/i.test(label) || /Source_Information/i.test(key)) {
        const rich = td.querySelector(
          'lightning-formatted-rich-text, lightning-output-rich-text, lightning-base-formatted-rich-text'
        );
        if (rich && rich.innerHTML) {
          sourceHtml = sanitizeRichHTML(rich.innerHTML);
        } else {
          const txtEl = td.querySelector('lightning-base-formatted-text, lightning-formatted-text, lst-basic-rich-text');
          const html = txtEl?.innerHTML;
          sourceText = html ? htmlToPlain(html) : pullText(txtEl || td);
        }
      }
      if (/^additional info review$/i.test(label) || /AdditionalInfoReview/i.test(key)) {
        const a = queryDeepForLink(td);
        if (a) add = { title: (a.getAttribute('title') || a.textContent || '').trim(), href: a.getAttribute('href') || '#', rowIndex };
      }
    });
    if (sourceText || sourceHtml || add || recordHref) {
      rows.push({ sourceText, sourceHtml, add, rowIndex, recordHref });
    }
  });
  dlog("harvestRowsFromGrid -> rows found:", rows.length);
  if (rows.length) {
    console.table(rows.map(r => ({ rowIndex: r.rowIndex, hasHtml: !!r.sourceHtml, hasText: !!r.sourceText, add: !!r.add, href: r.recordHref })));
  }
  return rows;
}
async function getRowwiseSourceInfoEnsured() {
  const onSI = await ensureOnTab("Source Info") || await ensureOnTab("Source Information");
  if (!onSI) return [];
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const grids = findSourceInfosGrids();
    const rows = grids.flatMap(g => harvestRowsFromGrid(g));
    if (rows.length) return rows;
    await new Promise(r => setTimeout(r, 200));
  }
  return [];
}
function openTabEarly() {
  const w = window.open("about:blank", "_blank");
  if (!w || !w.document) {
    alert("Couldn’t open a new tab. Please allow popups for this site.");
    return null;
  }
  try {
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
      <title>Interface Formatter</title>
      <style>body{font-family:system-ui,sans-serif;padding:24px;color:#1f2937}
      .muted{opacity:.7}</style></head>
      <body><h2>Interface Formatter</h2>
      <p class="muted">Loading…</p></body></html>`);
    w.document.close();
  } catch(_) {}
  return w;
}
const norm = s => (s || "").replace(/\s+/g, " ").trim();
const valOf = el => el?.value ?? el?.getAttribute?.("value") ?? el?.textContent ?? el?.innerText ?? el?.title ?? "";
function mergeConfig(target, source) {
  if (!source) return;
  if (source.styleWords) target.styleWords.push(...source.styleWords);
  if (source.boldLinesKeyWords) target.boldLinesKeyWords.push(...source.boldLinesKeyWords);
}
function getActiveTabLabel(){
  const root = top?.document || document;
  for (const r of allRoots(root)) {
    try {
      const selected = r.querySelector('[role="tab"][aria-selected="true"]');
      if (!selected) continue;
      const lbl = selected.getAttribute("data-label") || selected.textContent || "";
      return norm(lbl);
    } catch(_) {}
  }
  return null;
}
function safeClick(el){
  try {
    el.dispatchEvent(new MouseEvent("mousedown", {bubbles:true, cancelable:true}));
    el.dispatchEvent(new MouseEvent("mouseup",   {bubbles:true, cancelable:true}));
    el.click();
  } catch(_) { try { el.click(); } catch(_) {} }
}
async function ensureOnTab(label, {timeout=6000} = {}){
  const root = top?.document || document;
  const wanted = findTabByLabel(label);
  if (!wanted) return false;
  if (wanted.getAttribute("aria-selected") === "true") return true;
  safeClick(wanted);
  const ok = await waitFor(() => wanted.getAttribute("aria-selected") === "true", {timeout});
  return !!ok;
}
function findRecordIdOnce() {
  const root = top?.document || document;
  const tHit = (root.title || "").match(CN_RE);
  if (tHit) return tHit[0];
  for (const r of allRoots(root)) {
    try {
      const els = [
        ...r.querySelectorAll("[data-output-element-id='output-field']"),
        ...r.querySelectorAll("lightning-formatted-text[slot='output']"),
        ...r.querySelectorAll("lightning-formatted-text"),
        ...r.querySelectorAll(".slds-page-header__title, h1, h2, [title], [aria-label]")
      ];
      for (const el of els) {
        const candidates = [
          el?.textContent, el?.innerText, el?.title, el?.getAttribute?.("title"),
          el?.getAttribute?.("aria-label"), el?.getAttribute?.("value")
        ];
        for (const s of candidates) {
          const m = (s || "").match(CN_RE);
          if (m) return m[0];
        }
      }
    } catch(_) {}
  }
  try {
    const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const m = (node.nodeValue || "").match(CN_RE);
      if (m) return m[0];
    }
  } catch(_) {}
  return null;
}
function compactLines(arr) {
  const out = [];
  let prevBlank = true;
  for (const s of arr) {
    const isBlank = !((s || "").replace(/\s+/g, "").length);
    if (isBlank) {
      if (prevBlank) continue;
      prevBlank = true;
      continue;
    }
    prevBlank = false;
    out.push(s);
  }
  if (out.length && !((out[out.length - 1] || "").replace(/\s+/g, "").length)) out.pop();
  return out;
}
async function getRecordIdSmart(timeoutMs = 8000) {
  let id = findRecordIdOnce();
  if (id) return id;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise(r => setTimeout(r, 150));
    id = findRecordIdOnce();
    if (id) return id;
  }
  return null;
}
function findTabByLabel(label){
  const root = top?.document || document;
  const isLbl = s => (s||"").replace(/\s+/g," ").trim().toLowerCase() === label.toLowerCase();
  for (const r of allRoots(root)) {
    try {
      const el = r.querySelector(`[role="tab"][data-label="${label}"]`);
      if (el) return el;
      const tabs = Array.from(r.querySelectorAll('[role="tab"]'));
      const hit = tabs.find(t => isLbl(t.getAttribute("data-label")) || isLbl(t.textContent));
      if (hit) return hit;
    } catch(_) {}
  }
  return null;
}
function waitFor(predicate, {interval=150, timeout=4000, label="waitFor"} = {}){
  return new Promise(resolve => {
    const start = Date.now();
    const tick = () => {
      try {
        const v = predicate();
        if (v) {
          dlog(label, "-> success");
          return resolve(v);
        }
      } catch(e) { dwarn(label, "predicate threw", e); }
      if (Date.now() - start >= timeout) {
        dwarn(label, "-> timeout after", timeout, "ms");
        return resolve(null);
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}
function getOUFromPage() {
  const keyMap = new Map(Object.keys(config).map(k => [k.toLowerCase(), k]));
  const tryMatch = (str) => {
    const t = norm(str);
    return t ? (keyMap.get(t.toLowerCase()) || null) : null;
  };
  const root = top?.document || document;
  for (const r of allRoots(root)) {
    try {
      const lfts = Array.from(r.querySelectorAll("lightning-formatted-text"));
      for (const el of lfts) {
        const v = valOf(el);
        const hit = tryMatch(v);
        if (hit) return hit;
      }
    } catch(_) {}
    try {
      const all = Array.from(r.querySelectorAll("*"));
      const labelEl = all.find(n => /Responsible\s+Integrated\s+OU/i.test(norm(n.textContent)));
      if (labelEl) {
        const container = labelEl.closest("records-record-layout-item, lightning-layout, div, section") || labelEl.parentElement;
        if (container) {
          const valueEl =
            container.querySelector("lightning-formatted-text") ||
            container.querySelector("[data-output-element], [data-value], [title]");
          const v = valOf(valueEl);
          const hit = tryMatch(v);
          if (hit) return hit;
        }
      }
    } catch(_) {}
  }
  return null;
}
function sanitizeRichHTML(html) {
  if (!html) return "";
  const allowed = new Set(["P","DIV","BR","SPAN","STRONG","B","EM","I","U","UL","OL","LI","HR"]);
  const allowedStyleProps = new Set([
    "font-weight","font-style","text-decoration","color","background-color"
  ]);
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const walk = (node) => {
    if (node.nodeType === Node.COMMENT_NODE) { node.remove(); return; }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName;
      if (!allowed.has(tag)) {
        const parent = node.parentNode;
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
        return;
      }
      for (const attr of Array.from(node.attributes)) {
        const an = attr.name.toLowerCase();
        const av = attr.value;
        if (an === "style" && tag === "SPAN") {
          const kept = [];
          av.split(";").forEach(rule => {
            const [k,v] = rule.split(":");
            if (!k || !v) return;
            const kk = k.trim().toLowerCase();
            if (allowedStyleProps.has(kk)) kept.push(`${kk}:${v.trim()}`);
          });
          if (kept.length) node.setAttribute("style", kept.join(";")); else node.removeAttribute("style");
        } else {
          node.removeAttribute(attr.name);
        }
      }
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(tpl.content);
  return tpl.innerHTML
    .replace(/\r\n/g, "\n")      // normalize
    .replace(/\n{3,}/g, "\n\n"); // compact big gaps
}
function formatText(text, txtType, styleWords, boldLinesKeyWords, applyCombinedStylesFn) {
  text = text.replace(/\r\n|\r/g, "\n");
  text = text.replace(/(?<!\*)\*(?!\*)/g, "\n*");
  text = text.replace(/-###-From (SR|PE)-/g, "\n$&");
  const linesArr = text.split("\n").filter(l => l.trim().length > 0);
  const DATE_RE = /(\b(?:\d{4}[-/.](?:\d{1,2}|[A-Za-z]{3})[-/.]\d{1,2}|(?:\d{1,2}[-/ ](?:[A-Za-z]{3,9})[-/ ]\d{4})|(?:[A-Za-z]{3,9} \d{1,2}, \d{4})|(?:\d{1,2}[-/]\d{1,2}[-/]\d{4}))(?: \d{1,2}:\d{2}(?::\d{2})?(?: ?[APap][Mm])?)?\b)/;
  let localLinks = [];
  let startLine = 0;
  let linkIdCounter = 0;
  const newLinesArr = [];
  linesArr.forEach((l, lineNo) => {
    l = l.replace(/\s+$/, "");
    l = l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const dateMatch = l.match(DATE_RE);
    const hasDate = !!dateMatch;
    if (hasDate) {
      const dateStr = dateMatch[0];
      l = `<span style="position: relative;" id="lnk${linkIdCounter}">
             <span class="arrowPointer" id="lnk${linkIdCounter}-arrow">&#x2192;</span>${l}
           </span>`;
      if (txtType === "General") {
        localLinks.push({ id:`lnk${linkIdCounter}`, title:dateStr, level:1, start:startLine, end:lineNo });
        startLine = lineNo + 1;
      } else {
        if (localLinks.length > 0) localLinks[localLinks.length - 1].end = lineNo - 1;
        localLinks.push({ id:`lnk${linkIdCounter}`, title:dateStr, level:1, start:lineNo, end:null });
      }
      linkIdCounter++;
    }
    (boldLinesKeyWords || []).forEach(kw => {
      if (!hasDate && l.indexOf(kw) >= 0) {
        l = `<span style="position: relative;" id="lnk${linkIdCounter}">
               <span class="arrowPointer" id="lnk${linkIdCounter}-arrow">&#x2192;</span>${l}
             </span>`;
        localLinks.push({ id:`lnk${linkIdCounter}`, title:kw, level:1, start:lineNo, end:lineNo });
        linkIdCounter++;
      }
    });
    l = (applyCombinedStylesFn || applyCombinedStyles)(l, styleWords || []);
    newLinesArr.push(l);
  });
  if (localLinks.length > 0 && txtType !== "General") {
    localLinks[localLinks.length - 1].end = newLinesArr.length - 1;
    startLine = newLinesArr.length;
  }
  if (localLinks.length === 0) return { lines: newLinesArr, links: [] };
  const LinksSorted = localLinks.concat().sort((a, b) => {
    const dateA = new Date(a.title); const dateB = new Date(b.title);
    if (isNaN(dateA) || isNaN(dateB)) return a.title.localeCompare(b.title);
    return dateA - dateB;
  });
  return { lines: newLinesArr, links: LinksSorted };
}
async function getOUEnsured(){
  let ou = getOUFromPage();
  if (ou) return ou;
  const onDetails = await ensureOnTab("Details", {timeout: 8000});
  if (!onDetails) return null;
  ou = await waitFor(() => getOUFromPage(), {timeout: 5000});
  return ou || null;
}
function findSourceInfoLinkInRow(rowEl) {
  const headerCell = rowEl.querySelector('th[role="rowheader"][data-label="Source Info ID"]');
  if (headerCell) {
    const a = headerCell.querySelector('a[href]');
    if (a) {
      const href = a.getAttribute('href') || a.href;
      dlog("Row link via rowheader:", href);
      return href;
    }
  }
  const hover = rowEl.querySelector('records-hoverable-link a[href]');
  if (hover) {
    const href = hover.getAttribute('href') || hover.href;
    dlog("Row link via hoverable-link:", href);
    return href;
  }
  const allAs = Array.from(rowEl.querySelectorAll('a[href]'));
  const byText = allAs.find(a => /SourceInfo-\d{3,}/i.test((a.textContent || '').trim()));
  if (byText) {
    const href = byText.getAttribute('href') || byText.href;
    dlog("Row link via text match:", href);
    return href;
  }
  const byPrefix = allAs.find(a => /\/lightning\/r\/a5A\w+\/view/i.test(a.getAttribute('href') || a.href || ''));
  if (byPrefix) {
    const href = byPrefix.getAttribute('href') || byPrefix.href;
    dlog("Row link via id prefix:", href);
    return href;
  }
  dwarn("No Source Info link found in row.");
  return null;
}
(async function run() {
  const tab = openTabEarly();
  dlog("RUN start, url:", location.href);
  if (!tab) return;
  const originalTab = getActiveTabLabel();
  dlog("Active tab at start:", originalTab);
  const OUKey = await getOUEnsured();
  dlog("OUKey:", OUKey);
  const finalConfig = { styleWords: [], boldLinesKeyWords: [] };
  if (OUKey && config[OUKey]) {
    mergeConfig(finalConfig, config[OUKey]);
  } else {
    console.warn("[Interface Formatter] OU not found in page or not defined in styles.js.", OUKey);
  }
  if (finalConfig.styleWords.length) {
    const seen = new Set();
    finalConfig.styleWords = finalConfig.styleWords.filter(sw => {
      const key = sw.style + "||" + (sw.words || []).join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const rows = await getRowwiseSourceInfoEnsured();
  dlog("Stored list URL:", __LIST_URL__);
  dlog("Total rows to visit:", rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    dlog(`Row ${i+1}/${rows.length} -> href:`, r.recordHref);
    if (!r.recordHref) continue;
    try {
      const ok = await navigateTo(r.recordHref);
      if (!ok) continue;
      const full = await readSourceInfoFromDetails();
      if (full.html) { r.sourceHtml = full.html; r.sourceText = ""; }
      else if (full.text) { r.sourceText = full.text; }
      dlog(`Row ${i+1} harvested -> html?`, !!r.sourceHtml, "text?", !!r.sourceText);
    } catch(_) {}
    await goBackToSourceInfoTab();
  }
  const srcRows = rows.filter(r => (r.sourceText || r.sourceHtml) && !r.add);
  const flaggedRows = rows.filter(r => r.add && (r.sourceText || r.sourceHtml));
  dlog("Rows with Source Info:", srcRows.length, "flagged:", flaggedRows.length);
  const recordId = (await getRecordIdSmart()) || "Record";
  if (originalTab) {
    if (!(await ensureOnTab(originalTab))) {
      if (/^details$/i.test(originalTab)) {
        await ensureOnTab("Details");
      } else if (/source info(rmation)?/i.test(originalTab)) {
        await ensureOnTab("Source Information") || await ensureOnTab("Source Info");
      }
    }
  }
  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function addRowContent(r, sectionTitle, lines, links, styleWords, boldLinesKeyWords) {
    if (r.sourceHtml && r.sourceHtml.trim()) {
      lines.push(`<div class="from-rich">${r.sourceHtml}</div>`);
    } else if (r.sourceText) {
      const ft = formatText(r.sourceText, sectionTitle, styleWords, boldLinesKeyWords, applyCombinedStyles);
      lines.push(...ft.lines);
      links.push(...ft.links);
    }
  }
  function applyCombinedStyles(text, styleRules) {
    let events = [];
    styleRules.forEach(rule => {
      rule.words.forEach(word => {
        const pattern = /\s/.test(word)
          ? escapeRegExp(word)
          : "\\b" + escapeRegExp(word) + "\\b";
        const regex = new RegExp(pattern, "gi");
        let match;
        while ((match = regex.exec(text)) !== null) {
          events.push({
            index: match.index,
            type: "start",
            style: rule.style
          });
          events.push({
            index: match.index + match[0].length,
            type: "end",
            style: rule.style
          });
        }
      });
    });
    events.sort((a, b) => {
      if (a.index !== b.index) return a.index - b.index;
      return a.type === "start" ? -1 : 1;
    });
    let result = "";
    let currentIndex = 0;
    let activeStyles = [];
    events.forEach(event => {
      if (event.index > currentIndex) {
        let segment = text.slice(currentIndex, event.index);
        if (activeStyles.length > 0) {
          let combined = activeStyles.join(";");
          result += `<span style="${combined}">${segment}</span>`;
        } else {
          result += segment;
        }
        currentIndex = event.index;
      }
      if (event.type === "start") {
        activeStyles.push(event.style);
      } else {
        let idx = activeStyles.indexOf(event.style);
        if (idx !== -1) {
          activeStyles.splice(idx, 1);
        }
      }
    });
    if (currentIndex < text.length) {
      let segment = text.slice(currentIndex);
      if (activeStyles.length > 0) {
        let combined = activeStyles.join(";");
        result += `<span style="${combined}">${segment}</span>`;
      } else {
        result += segment;
      }
    }
    return result;
  }
  if (finalConfig.styleWords.length || finalConfig.boldLinesKeyWords.length) {
    var styleWords = finalConfig.styleWords;
    var boldLinesKeyWords = finalConfig.boldLinesKeyWords;
    styleWords.forEach(s => {
      s.words.sort((a, b) => b.length - a.length);
    });
    var lines = [];
    var links = [];
    var linkIdCounter = 0;
    const recordId = (await getRecordIdSmart()) || "Record";
    const textInfoF = ["Source Information"];
    if (srcRows.length) {
      const t = "Source Information";
      const tId = t.replace(/\W/gi, "");
      lines.push('<div class="card">');
      lines.push('<h2 id="' + tId + '"><span class="arrowPointer" id="' + tId + '-arrow">&#x2192;</span>' + t + "</h2>");
      links.push({ id: tId, title: t });
      srcRows.forEach(r => addRowContent(r, t, lines, links, styleWords, boldLinesKeyWords));
      lines.push("</div>");
    }
    if (flaggedRows.length) {
      const t = "Additional Source Information";
      const tId = t.replace(/\W/gi, "");
      lines.push('<div class="card">');
      lines.push('<h2 id="' + tId + '"><span class="arrowPointer" id="' + tId + '-arrow">&#x2192;</span>' + t + "</h2>");
      links.push({ id: tId, title: t });
      flaggedRows.forEach(r => addRowContent(r, t, lines, links, styleWords, boldLinesKeyWords));
      lines.push("</div>");
    }
    var content = lines.join(""); 
    var groupedNav = [];
    var currentGroup = null;
    links.forEach(function(link) {
      if (!link.level) {
        currentGroup = { header: link, children: [] };
        groupedNav.push(currentGroup);
      } else {
        if (currentGroup) {
          currentGroup.children.push(link);
        } else {
          currentGroup = {
            header: { id: "default", title: "Default" },
            children: [link]
          };
          groupedNav.push(currentGroup);
        }
      }
    });
    var styleBlock = `
  <style>
  body {
    margin: 0;
    padding: 0;
    font-family: system-ui, sans-serif;
    background: #EEF2F7;
  }
  #modern-nav {
    position: fixed;
    top: 0;
    left: 0;
    width: 280px;
    height: 100vh;
    background: #2C5282;
    color: #fff;
    padding: 20px;
    box-shadow: 3px 0 8px rgba(0, 0, 0, 0.15);
    overflow-y: auto;
    box-sizing: border-box;
    z-index: 9999;
  }
  .ou-pill{
    margin: 4px 0 12px 0;
    display: inline-block;
    padding: 6px 10px;
    border-radius: 9999px;
    background: rgba(255,255,255,0.15);
    color: #E6F6FF;
    font-weight: 600;
    letter-spacing:.2px;
  }
  .brand small{ display:block; opacity:.85; font-weight:600; margin-top:2px; }
  .brand {
    font-size: 1.4rem;
    font-weight: 900;
    margin-bottom: 24px;
    background: linear-gradient(90deg, #BEE3E8 0%, #63B3ED 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: 1px;
    line-height: 1.4;
  }
  #modern-nav ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  #modern-nav li {
    margin-bottom: 8px;
  }
  #modern-nav ul ul {
    padding-left: 1.2em;
  }
  #modern-nav a {
    color: #F8FAFC;
    text-decoration: none;
    display: inline-block;
    padding: 5px 0;
    border-radius: 4px;
    transition: transform 0.25s ease, background 0.25s ease;
  }
  #modern-nav a:hover {
    background: rgba(255,255,255,0.1);
    transform: scale(1.05);
  }
  #main-content {
    margin-left: 300px;
    padding: 20px;
    box-sizing: border-box;
    min-height: 100vh;
  }
  .card {
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
    padding: 20px;
    margin-bottom: 20px;
    box-sizing: border-box;
    word-wrap: break-word;
    white-space: normal;
    line-height: 1.5;
  }
  h2 {
    margin-top: 0;
    margin-bottom: 12px;
    font-size: 1.2rem;
    border-bottom: 2px solid #3182FE;
    padding-bottom: 6px;
    color: #2D3748;
  }
  @media (max-width: 768px) {
    #modern-nav {
      position: static;
      width: 100%;
      height: auto;
      box-shadow: none;
      margin-bottom: 10px;
    }
    #main-content {
      margin-left: 0;
      min-height: auto;
    }
  }
  .arrowPointer {
    color: red !important;
    background-color: white;
    font-weight: bold;
    display: none;
    font-size: 1.2em;
    margin-right: 5px;
    animation: arrowFade 3s ease-out;
  }
  @keyframes arrowFade {
    0% { opacity: 1; }
    100% { opacity: 0; }
  }
  </style>
  `;
    var htmlParts = [];
    htmlParts.push('<div id="modern-nav">');
    htmlParts.push(`<div class="brand">Interface Formatter<br/>${recordId}</div>`);
    const ouText = OUKey ? `OU: ${OUKey}` : "OU: Unknown";
    htmlParts.push(`<ul>`);
    htmlParts.push(`<li class="ou-pill">${ouText}</li>`);
    groupedNav.forEach(group => {
      htmlParts.push("<li>");
      htmlParts.push(
        `<a href="#" class="nav-link" data-target="${group.header.id}">
          ${group.header.title}
        </a>`
      );
      if (group.children && group.children.length > 0) {
        htmlParts.push("<ul>");
        group.children.forEach(child => {
          htmlParts.push(
            `<li>
              <a href="#" class="nav-link" data-target="${child.id}">
                ${child.title}
              </a>
            </li>`
          );
        });
        htmlParts.push("</ul>");
      }
      htmlParts.push("</li>");
    });
    htmlParts.push("</ul>");
    htmlParts.push("</div>");
    htmlParts.push(`<div id="main-content">${content}</div>`);
    var scriptBlock = `
      <script>
        console.log('Nav is fixed on wide screens, stacked on top at narrow. Date-based line re-ordering applied.');
      </script>
    `;
    function renderInTab(html) {
      try {
        tab.document.open();
        tab.document.write(`<!doctype html><html><head><meta charset="utf-8">
          <title>Interface Formatter</title></head>
          <body>${html}</body></html>`);
        tab.document.close();
      } catch (_) {
        setTimeout(() => {
          try {
            tab.document.open();
            tab.document.write(`<!doctype html><html><head><meta charset="utf-8">
              <title>Interface Formatter</title></head>
              <body>${html}</body></html>`);
            tab.document.close();
          } catch(e) {}
        }, 100);
      }
    }
    renderInTab(styleBlock + htmlParts.join("") + scriptBlock);
  }
})();