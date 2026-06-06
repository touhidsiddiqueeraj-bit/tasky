// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — DEPENDENCIES, GLOBAL SEARCH & RICH TEXT  (tasky-deps-search.js)
//  Load AFTER tasky-voice.js (last in the chain)
//
//  Feature A: Global Search  (Alt+R)
//  Feature B: Task Dependencies ("Blocked by" / "Blocks")
//  Feature C: Rich Text in Chat & Comments (Markdown renderer)
// ═══════════════════════════════════════════════════════════════════════════

(function taskyExtensions() {
'use strict';

/* ─────────────────────────────────────────────────────────────────────────
   STYLE INJECTION
   ───────────────────────────────────────────────────────────────────────── */
const CSS = `

/* ══════════════════════════════════════════════════════════════
   A. GLOBAL SEARCH OVERLAY
   ══════════════════════════════════════════════════════════════ */
#gs-overlay {
  position: fixed; inset: 0; z-index: 10200;
  background: rgba(5,3,15,0.78);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  display: none; align-items: flex-start; justify-content: center;
  padding-top: clamp(60px, 10vh, 130px);
  animation: gs-fade-in .18s ease;
}
#gs-overlay.visible { display: flex; }
@keyframes gs-fade-in { from{opacity:0} to{opacity:1} }

#gs-box {
  width: min(580px, 94vw);
  background: linear-gradient(145deg,#16132a,#0f0d1c);
  border: 1.5px solid rgba(139,92,246,0.38);
  border-radius: 18px;
  box-shadow: 0 24px 72px rgba(0,0,0,0.7), 0 0 0 1px rgba(139,92,246,0.1);
  overflow: hidden;
  display: flex; flex-direction: column;
  max-height: 70vh;
  animation: gs-slide-in .22s cubic-bezier(0.34,1.56,0.64,1) both;
}
@keyframes gs-slide-in {
  from { opacity:0; transform:translateY(-18px) scale(0.97); }
  to   { opacity:1; transform:translateY(0)     scale(1); }
}

#gs-input-row {
  display: flex; align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255,255,255,0.07);
  gap: 10px; flex-shrink: 0;
}
.gs-search-icon { font-size: 17px; opacity: 0.55; flex-shrink: 0; }
#gs-input {
  flex: 1; background: transparent; border: none; outline: none;
  font-size: 16px; color: #e2d9ff; font-family: inherit;
}
#gs-input::placeholder { color: rgba(196,181,253,0.35); }
.gs-kbd-hint {
  font-size: 10.5px; color: rgba(196,181,253,0.35);
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 5px; padding: 2px 7px; white-space: nowrap; flex-shrink: 0;
}
body.light-mode .gs-kbd-hint { background:rgba(0,0,0,0.05); border-color:rgba(0,0,0,0.12); color:rgba(0,0,0,0.35); }

#gs-results {
  overflow-y: auto; flex: 1;
  scrollbar-width: thin;
  scrollbar-color: rgba(139,92,246,0.3) transparent;
}
#gs-results::-webkit-scrollbar { width: 4px; }
#gs-results::-webkit-scrollbar-thumb { background: rgba(139,92,246,0.3); border-radius: 4px; }

.gs-empty {
  padding: 28px 20px; text-align: center;
  font-size: 13px; color: rgba(196,181,253,0.38);
}
.gs-section-hdr {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .1em; color: rgba(139,92,246,0.6);
  padding: 10px 16px 4px; flex-shrink: 0;
}
.gs-item {
  display: flex; align-items: center; gap: 11px;
  padding: 10px 16px; cursor: pointer;
  transition: background .12s;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.gs-item:hover, .gs-item.gs-focused { background: rgba(139,92,246,0.13); }
.gs-item-num {
  font-size: 11px; font-weight: 700; color: rgba(139,92,246,0.7);
  min-width: 28px; font-family: monospace;
}
.gs-item-text { flex: 1; font-size: 13.5px; color: #e2d9ff; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
body.light-mode .gs-item-text { color: #1e1b4b; }
.gs-item-text mark { background: rgba(139,92,246,0.3); color: #c4b5fd; border-radius: 2px; padding: 0 1px; }
.gs-item-col {
  font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 5px; white-space: nowrap; flex-shrink: 0;
}
.gs-item-col.todo    { background:rgba(139,92,246,0.2); color:#a78bfa; }
.gs-item-col.working { background:rgba(245,158,11,0.2); color:#fbbf24; }
.gs-item-col.done    { background:rgba(16,185,129,0.15); color:#6ee7b7; }
.gs-item-pri { font-size: 14px; flex-shrink: 0; }
.gs-footer {
  padding: 8px 16px;
  border-top: 1px solid rgba(255,255,255,0.06);
  display: flex; gap: 14px; flex-shrink: 0;
  font-size: 11px; color: rgba(196,181,253,0.35);
}
.gs-footer kbd {
  display: inline-block; background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.14); border-radius: 4px;
  padding: 1px 5px; font-size: 10px; color: rgba(196,181,253,0.6);
  font-family: monospace;
}
body.light-mode #gs-box { background: #ffffff; border-color: rgba(109,40,217,0.2); }
body.light-mode .gs-section-hdr { color: rgba(109,40,217,0.55); }
body.light-mode .gs-footer { border-top-color:rgba(0,0,0,0.07); color:rgba(0,0,0,0.35); }
body.light-mode .gs-footer kbd { background:rgba(0,0,0,0.05); border-color:rgba(0,0,0,0.12); color:rgba(0,0,0,0.4); }
body.light-mode .gs-item-text mark { background:rgba(109,40,217,0.15); color:#6d28d9; }

/* ══════════════════════════════════════════════════════════════
   B. TASK DEPENDENCIES
   ══════════════════════════════════════════════════════════════ */

/* Blocked badge on task card */
.dep-blocked-badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 6px;
  background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.38);
  color: #fca5a5; white-space: nowrap; flex-shrink: 0;
  cursor: pointer;
}
.dep-blocked-badge:hover { background: rgba(239,68,68,0.25); }

/* Red-border glow on blocked cards */
.task-card.dep-is-blocked {
  border-color: rgba(239,68,68,0.5) !important;
  box-shadow: 0 0 0 2px rgba(239,68,68,0.18), inset 0 0 20px rgba(239,68,68,0.04);
}

/* Dependencies modal */
#dep-modal-overlay {
  position: fixed; inset: 0; z-index: 9800;
  background: rgba(5,3,15,0.75);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  display: none; align-items: center; justify-content: center;
}
#dep-modal-overlay.visible { display: flex; animation: gs-fade-in .2s ease; }
#dep-modal {
  width: min(500px,94vw); max-height: 85vh;
  background: linear-gradient(145deg,#16132a,#0f0d1c);
  border: 1.5px solid rgba(139,92,246,0.35);
  border-radius: 18px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.65);
  display: flex; flex-direction: column; overflow: hidden;
  animation: gs-slide-in .22s cubic-bezier(0.34,1.56,0.64,1) both;
}
body.light-mode #dep-modal { background: #fff; border-color: rgba(109,40,217,0.2); }
.dep-modal-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 20px 14px; border-bottom: 1px solid rgba(255,255,255,0.07);
  flex-shrink: 0;
}
.dep-modal-title {
  font-size: 15px; font-weight: 800; color: #e2d9ff;
  display: flex; align-items: center; gap: 8px;
}
body.light-mode .dep-modal-title { color: #1e1b4b; }
.dep-modal-task-name {
  font-size: 11px; color: rgba(196,181,253,0.5);
  font-weight: 500; max-width: 300px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
body.light-mode .dep-modal-task-name { color: rgba(109,40,217,0.5); }
.dep-close-btn {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.45); border-radius: 9px; width: 30px; height: 30px;
  font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: background .15s, color .15s;
}
.dep-close-btn:hover { background: rgba(239,68,68,0.15); color: #f87171; border-color: rgba(239,68,68,0.3); }
.dep-modal-body { flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 20px; }

.dep-section-title {
  font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .09em;
  color: rgba(196,181,253,0.45); margin-bottom: 10px;
}
body.light-mode .dep-section-title { color: rgba(109,40,217,0.45); }

.dep-search-input {
  width: 100%; box-sizing: border-box;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px; padding: 10px 14px;
  font-size: 13.5px; color: #e2d9ff; outline: none; font-family: inherit;
  transition: border-color .2s, background .2s;
}
.dep-search-input::placeholder { color: rgba(196,181,253,0.32); }
.dep-search-input:focus { border-color: rgba(139,92,246,0.5); background: rgba(139,92,246,0.06); }
body.light-mode .dep-search-input { background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.12); color: #1e1b4b; }
body.light-mode .dep-search-input:focus { border-color: rgba(109,40,217,0.4); background: rgba(109,40,217,0.05); }

.dep-task-list { display: flex; flex-direction: column; gap: 5px; max-height: 180px; overflow-y: auto;
  scrollbar-width: thin; scrollbar-color: rgba(139,92,246,0.28) transparent; }
.dep-task-list::-webkit-scrollbar { width: 4px; }
.dep-task-list::-webkit-scrollbar-thumb { background: rgba(139,92,246,0.28); border-radius: 4px; }

.dep-task-row {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 10px; border-radius: 9px;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07);
  cursor: pointer; transition: background .12s, border-color .12s;
  user-select: none;
}
.dep-task-row:hover { background: rgba(139,92,246,0.1); border-color: rgba(139,92,246,0.25); }
.dep-task-row.selected { background: rgba(139,92,246,0.18); border-color: rgba(139,92,246,0.45); }
.dep-task-row-num { font-size: 11px; font-weight: 700; color: rgba(139,92,246,0.7); min-width: 28px; font-family: monospace; }
.dep-task-row-text { flex: 1; font-size: 12.5px; color: #e2d9ff; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
body.light-mode .dep-task-row-text { color: #1e1b4b; }
.dep-task-row-col { font-size: 10px; padding: 1px 6px; border-radius: 4px; white-space: nowrap; flex-shrink: 0; }
.dep-task-row-col.todo    { background:rgba(139,92,246,0.2);color:#a78bfa; }
.dep-task-row-col.working { background:rgba(245,158,11,0.15);color:#fbbf24; }
.dep-task-row-col.done    { background:rgba(16,185,129,0.12);color:#6ee7b7; }
.dep-check { width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid rgba(255,255,255,0.2); flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; }
.dep-task-row.selected .dep-check { background: #8B5CF6; border-color: #8B5CF6; color: #fff; }

.dep-current-list { display: flex; flex-direction: column; gap: 5px; }
.dep-current-item {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 10px; border-radius: 9px;
  background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2);
}
.dep-current-item-num { font-size: 11px; font-weight: 700; color: rgba(239,68,68,0.7); min-width: 28px; font-family: monospace; }
.dep-current-item-text { flex: 1; font-size: 12.5px; color: #fca5a5; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dep-current-item-status { font-size: 10px; padding: 1px 6px; border-radius: 4px; flex-shrink: 0; }
.dep-current-item-status.done { background:rgba(16,185,129,0.15); color:#6ee7b7; }
.dep-current-item-status.pending { background:rgba(239,68,68,0.12); color:#fca5a5; }
.dep-remove-btn {
  background: transparent; border: none; color: rgba(239,68,68,0.45);
  cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px;
  border-radius: 5px; transition: color .15s, background .15s; flex-shrink: 0;
}
.dep-remove-btn:hover { color: #fca5a5; background: rgba(239,68,68,0.15); }

.dep-also-blocks { font-size: 11.5px; color: rgba(196,181,253,0.5); line-height: 1.6; }
body.light-mode .dep-also-blocks { color: rgba(109,40,217,0.45); }
.dep-also-blocks strong { color: #c4b5fd; }
body.light-mode .dep-also-blocks strong { color: #6d28d9; }

.dep-modal-footer {
  display: flex; gap: 8px; padding: 14px 20px;
  border-top: 1px solid rgba(255,255,255,0.07); flex-shrink: 0;
}
.dep-save-btn {
  background: linear-gradient(135deg,#8B5CF6,#6d28d9);
  color: #fff; border: none; border-radius: 11px;
  padding: 10px 22px; font-size: 13.5px; font-weight: 700;
  cursor: pointer; transition: filter .15s, transform .12s;
  box-shadow: 0 4px 16px rgba(139,92,246,0.35);
}
.dep-save-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
.dep-cancel-btn {
  background: transparent; border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.45); border-radius: 11px;
  padding: 10px 18px; font-size: 13.5px; cursor: pointer;
  transition: background .15s, color .15s;
}
.dep-cancel-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.7); }

/* Blocker tooltip inline */
.dep-blocker-list-mini {
  font-size: 11px; color: rgba(196,181,253,0.52); margin-top: 3px;
  display: flex; flex-wrap: wrap; gap: 4px;
}
.dep-blocker-chip {
  background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.22);
  border-radius: 4px; padding: 1px 6px; color: #fca5a5; font-size: 10px;
  white-space: nowrap;
}
.dep-blocker-chip.done-chip {
  background: rgba(16,185,129,0.08); border-color: rgba(16,185,129,0.2); color: #6ee7b7;
  text-decoration: line-through; opacity: 0.7;
}

/* ══════════════════════════════════════════════════════════════
   C. RICH TEXT / MARKDOWN IN COMMENTS
   ══════════════════════════════════════════════════════════════ */
.rt-body {
  font-size: 13px; line-height: 1.65; color: #d4c8ff;
  word-break: break-word;
}
body.light-mode .rt-body { color: #2e1065; }

/* Inline elements */
.rt-body strong { font-weight: 700; color: #e2d9ff; }
body.light-mode .rt-body strong { color: #1e1b4b; }
.rt-body em { font-style: italic; color: #c4b5fd; }
body.light-mode .rt-body em { color: #6d28d9; }
.rt-body a { color: #a78bfa; text-decoration: underline; text-underline-offset: 2px; }
.rt-body a:hover { color: #c4b5fd; }
body.light-mode .rt-body a { color: #6d28d9; }
.rt-body code {
  font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
  font-size: 11.5px;
  background: rgba(139,92,246,0.14); border: 1px solid rgba(139,92,246,0.25);
  border-radius: 4px; padding: 1px 5px; color: #c4b5fd;
}
body.light-mode .rt-body code {
  background: rgba(109,40,217,0.08); border-color: rgba(109,40,217,0.2); color: #6d28d9;
}

/* Code block */
.rt-pre {
  margin: 8px 0;
  background: rgba(0,0,0,0.38); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px; padding: 10px 14px; overflow-x: auto;
  scrollbar-width: thin; scrollbar-color: rgba(139,92,246,0.3) transparent;
}
body.light-mode .rt-pre { background: rgba(0,0,0,0.05); border-color: rgba(0,0,0,0.1); }
.rt-pre code {
  background: none; border: none; padding: 0;
  font-size: 12px; color: #c4b5fd; white-space: pre; display: block;
}
body.light-mode .rt-pre code { color: #5b21b6; }
.rt-pre-lang {
  font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
  color: rgba(139,92,246,0.6); margin-bottom: 6px; display: block;
}

/* Lists */
.rt-ul { margin: 5px 0 5px 16px; padding: 0; list-style: disc; }
.rt-ol { margin: 5px 0 5px 18px; padding: 0; list-style: decimal; }
.rt-ul li, .rt-ol li { margin: 2px 0; font-size: 13px; }
body.light-mode .rt-ul li, body.light-mode .rt-ol li { color: #2e1065; }

/* Input preview row */
.tcp-input-row {
  position: relative;
}
.tcp-md-hint {
  position: absolute; bottom: calc(100% + 3px); right: 10px;
  font-size: 10px; color: rgba(196,181,253,0.35); pointer-events: none;
  display: flex; gap: 8px;
}
.tcp-md-hint code {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 3px; padding: 0 4px; font-family: monospace; color: rgba(196,181,253,0.5);
}
`;

// Inject styles
const styleEl = document.createElement('style');
styleEl.id = 'tasky-deps-search-styles';
styleEl.textContent = CSS;
document.head.appendChild(styleEl);

/* ─────────────────────────────────────────────────────────────────────────
   C. RICH TEXT MARKDOWN RENDERER  (no external lib, pure regex)
   ───────────────────────────────────────────────────────────────────────── */
function renderMarkdown(raw) {
    if (!raw) return '';

    // Escape helper (for plain text sections)
    function esc(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    const lines = raw.split('\n');
    const out = [];
    let i = 0;
    let inUl = false, inOl = false;

    function closeList() {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
    }

    function inlineRender(s) {
        // Code blocks inline
        s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${esc(c)}</code>`);
        // Bold **text**
        s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => `<strong>${t}</strong>`);
        // Italic *text*
        s = s.replace(/\*([^*]+)\*/g, (_, t) => `<em>${t}</em>`);
        // Italic _text_
        s = s.replace(/_([^_]+)_/g, (_, t) => `<em>${t}</em>`);
        // Links [text](url)
        s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, (_, t, u) =>
            `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`);
        // Auto-detect bare URLs
        s = s.replace(/(?<![">])(https?:\/\/[^\s<>"]+)/g, (_, u) =>
            `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`);
        return s;
    }

    while (i < lines.length) {
        const line = lines[i];

        // ── Fenced code block ```lang
        if (line.startsWith('```')) {
            closeList();
            const lang = line.slice(3).trim();
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].startsWith('```')) {
                codeLines.push(esc(lines[i]));
                i++;
            }
            out.push(
                `<div class="rt-pre">${lang ? `<span class="rt-pre-lang">${esc(lang)}</span>` : ''}<code>${codeLines.join('\n')}</code></div>`
            );
            i++;
            continue;
        }

        // ── Unordered list
        if (/^[-*+] /.test(line)) {
            if (inOl) { out.push('</ol>'); inOl = false; }
            if (!inUl) { out.push('<ul class="rt-ul">'); inUl = true; }
            out.push(`<li>${inlineRender(esc(line.replace(/^[-*+] /,'')))}</li>`);
            i++; continue;
        }

        // ── Ordered list
        if (/^\d+\. /.test(line)) {
            if (inUl) { out.push('</ul>'); inUl = false; }
            if (!inOl) { out.push('<ol class="rt-ol">'); inOl = true; }
            out.push(`<li>${inlineRender(esc(line.replace(/^\d+\. /,'')))}</li>`);
            i++; continue;
        }

        closeList();

        // ── Blank line
        if (line.trim() === '') {
            out.push('<br>');
            i++; continue;
        }

        // ── Regular paragraph
        out.push(`<span>${inlineRender(esc(line))}</span><br>`);
        i++;
    }
    closeList();
    return out.join('');
}
window._taskyRenderMarkdown = renderMarkdown;

/* ─────────────────────────────────────────────────────────────────────────
   PATCH: Upgrade comment panel to support Markdown
   ───────────────────────────────────────────────────────────────────────── */
function _patchCommentPanel() {
    // Wait until tasky-collab.js exposes these
    if (typeof _renderCommentFeed !== 'function' || typeof openComments !== 'function') {
        setTimeout(_patchCommentPanel, 200);
        return;
    }

    // Monkey-patch _renderCommentFeed to use markdown for comment text
    const _origRenderFeed = window._renderCommentFeed || _renderCommentFeed;
    function _enrichedRenderFeed(taskId, entries) {
        const feed = document.getElementById('tcp-feed');
        if (!feed) { _origRenderFeed(taskId, entries); return; }
        feed.innerHTML = '';

        if (!entries || entries.length === 0) {
            feed.innerHTML = '<div class="tcp-empty">No comments yet — add the first one!</div>';
            return;
        }

        const currentUserVal = window.currentUser;
        const sorted = [...entries].sort((a, b) => a.ts > b.ts ? 1 : -1);

        sorted.forEach(entry => {
            const isOwn = entry.authorUid && currentUserVal && entry.authorUid === currentUserVal.uid;
            const item = document.createElement('div');
            item.className = `tcp-entry tcp-${entry.type}${isOwn ? ' tcp-own' : ''}`;

            const escHtmlFn = typeof escHtml === 'function' ? escHtml : (s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
            const fmtTs = typeof fmtCommentTs === 'function' ? fmtCommentTs : (iso => new Date(iso).toLocaleTimeString());

            const authorLine = entry.type === 'comment'
                ? `<span class="tcp-author">@${escHtmlFn(entry.authorHandle || 'unknown')}</span>`
                : '';

            // For comments: render markdown; for activity: plain text
            const textHtml = entry.type === 'comment'
                ? `<div class="rt-body tcp-entry-text">${renderMarkdown(entry.text)}</div>`
                : `<span class="tcp-entry-text">⚡ ${escHtmlFn(entry.text)}</span>`;

            item.innerHTML = `
              <div class="tcp-entry-body">
                <div class="tcp-entry-inner">
                  ${authorLine}
                  ${textHtml}
                </div>
                ${isOwn && entry.type === 'comment' ? `<button class="tcp-del-btn" data-cid="${entry.id}" title="Delete">✕</button>` : ''}
              </div>
              <span class="tcp-ts">${fmtTs(entry.ts)}</span>`;

            feed.appendChild(item);
        });

        // Wire delete buttons
        feed.querySelectorAll('.tcp-del-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                if (typeof deleteComment === 'function') await deleteComment(taskId, parseFloat(btn.dataset.cid));
            });
        });
        feed.scrollTop = feed.scrollHeight;
    }

    // Patch global reference used internally by tasky-collab.js
    if (typeof window !== 'undefined') {
        // Override by injecting the enriched version into the same closure scope isn't possible,
        // so we override the DOM-affecting path by wrapping openComments
        const _origOpenComments = window.openComments || openComments;
        window.openComments = function(taskId, taskText, column, ownerUid) {
            _origOpenComments(taskId, taskText, column, ownerUid);
            // Wait for panel to mount, then attach enriched render
            setTimeout(() => {
                const feed = document.getElementById('tcp-feed');
                if (!feed) return;

                // Add markdown hint above input row
                const inputRow = document.querySelector('.tcp-input-row');
                if (inputRow && !inputRow.querySelector('.tcp-md-hint')) {
                    const hint = document.createElement('div');
                    hint.className = 'tcp-md-hint';
                    hint.innerHTML = '<code>**bold**</code> <code>*italic*</code> <code>`code`</code> <code>```block```</code>';
                    inputRow.appendChild(hint);
                }

                // Override the rendering function — re-load entries and re-render
                // We hook into the sendComment to re-render after submit
                const sendBtn = document.getElementById('tcp-send');
                const input = document.getElementById('tcp-input');
                if (sendBtn && input) {
                    const _origSend = sendBtn.onclick;
                    // Also listen for entries refreshed by live listener — observe DOM
                    // Actually the cleanest path: patch feed's render by watching mutations
                    if (window._tcpObserver) window._tcpObserver.disconnect();
                    window._tcpObserver = new MutationObserver(() => {
                        // For each tcp-entry comment that has tcp-entry-text (plain), upgrade it
                        feed.querySelectorAll('.tcp-entry.tcp-comment .tcp-entry-text:not(.rt-body)').forEach(el => {
                            const plainText = el.textContent;
                            el.outerHTML = `<div class="rt-body tcp-entry-text">${renderMarkdown(plainText)}</div>`;
                        });
                    });
                    window._tcpObserver.observe(feed, { childList: true, subtree: true });
                    // Store to disconnect on panel close
                    const closeBtn = document.getElementById('tcp-close-btn');
                    if (closeBtn) closeBtn.addEventListener('click', () => { if (window._tcpObserver) { window._tcpObserver.disconnect(); window._tcpObserver = null; } }, { once: true });
                }
            }, 100);
        };
    }
}

/* ─────────────────────────────────────────────────────────────────────────
   B. TASK DEPENDENCIES ENGINE
   ───────────────────────────────────────────────────────────────────────── */

// Storage: task.blockedBy = [ taskId, taskId, ... ]  (stored in task object)
// We persist by patching saveAll after modifications.

function _getAllTasks() {
    // Returns flat list: { id, number, text, column, priority, dueDate, blockedBy }
    if (typeof tasks === 'undefined') return [];
    const all = [];
    ['todo','working','done'].forEach(col => {
        (tasks[col] || []).forEach(t => all.push({ ...t, column: col }));
    });
    return all;
}

function _findTaskById(id) {
    if (typeof tasks === 'undefined') return null;
    for (const col of ['todo','working','done']) {
        const t = (tasks[col] || []).find(t => t.id === id);
        if (t) return { task: t, column: col };
    }
    return null;
}

function _isBlocked(task) {
    // Returns true if task has unfinished blockers
    if (!task.blockedBy || task.blockedBy.length === 0) return false;
    return task.blockedBy.some(bId => {
        const found = _findTaskById(bId);
        return found && found.column !== 'done';
    });
}

function _getBlockerDetails(task) {
    if (!task.blockedBy || task.blockedBy.length === 0) return [];
    return task.blockedBy.map(bId => {
        const found = _findTaskById(bId);
        if (!found) return null;
        return { id: bId, text: found.task.text, number: found.task.number, isDone: found.column === 'done' };
    }).filter(Boolean);
}

// ── Inject "🔗 Deps" button + blocked badge into task cards ──
function _patchCreateTaskCard() {
    if (typeof createTaskCard !== 'function') { setTimeout(_patchCreateTaskCard, 200); return; }
    const _origCreateCard = createTaskCard;
    createTaskCard = function(task, column) {
        const card = _origCreateCard(task, column);

        // Add blocked badge to task-meta > task-left
        const taskLeft = card.querySelector('.task-left');
        if (taskLeft) {
            const blockerDetails = _getBlockerDetails(task);
            const isBlocked = blockerDetails.some(b => !b.isDone);
            if (isBlocked) {
                card.classList.add('dep-is-blocked');
                const badge = document.createElement('span');
                badge.className = 'dep-blocked-badge';
                badge.title = 'This task is blocked. Click to manage dependencies.';
                badge.innerHTML = `🔒 Blocked`;
                badge.addEventListener('click', e => {
                    e.stopPropagation();
                    openDepModal(task, column);
                });
                taskLeft.appendChild(badge);

                // Render mini blocker chips
                const chipRow = document.createElement('div');
                chipRow.className = 'dep-blocker-list-mini';
                blockerDetails.forEach(b => {
                    const chip = document.createElement('span');
                    chip.className = 'dep-blocker-chip' + (b.isDone ? ' done-chip' : '');
                    chip.textContent = `#${b.number} ${b.text.slice(0,22)}${b.text.length > 22 ? '…' : ''}`;
                    chipRow.appendChild(chip);
                });
                taskLeft.appendChild(chipRow);
            }

            // Add deps button to hover controls
            const hoverControls = card.querySelector('.task-hover-controls');
            if (hoverControls) {
                const depsBtn = document.createElement('button');
                depsBtn.className = 'edit-btn';
                depsBtn.title = 'Manage dependencies (Blocked by)';
                depsBtn.textContent = '🔗';
                depsBtn.style.cssText = 'font-size:13px;';
                depsBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    openDepModal(task, column);
                });
                // Insert before delete button
                const del = hoverControls.querySelector('.delete-btn');
                hoverControls.insertBefore(depsBtn, del || null);
            }
        }
        return card;
    };
}

// ── Dependency Modal ──
let _depModalTask = null;
let _depModalColumn = null;
let _depSelectedBlockers = new Set(); // taskIds

function openDepModal(task, column) {
    _depModalTask = task;
    _depModalColumn = column;
    _depSelectedBlockers = new Set(task.blockedBy || []);

    let overlay = document.getElementById('dep-modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dep-modal-overlay';
        overlay.innerHTML = `
          <div id="dep-modal">
            <div class="dep-modal-hdr">
              <div>
                <div class="dep-modal-title">🔗 Task Dependencies</div>
                <div class="dep-modal-task-name" id="dep-modal-task-name"></div>
              </div>
              <button class="dep-close-btn" id="dep-close-btn">✕</button>
            </div>
            <div class="dep-modal-body">
              <!-- Current blockers -->
              <div>
                <div class="dep-section-title">Blocked By (must complete first)</div>
                <div class="dep-current-list" id="dep-current-list">
                  <div style="font-size:12px;color:rgba(196,181,253,0.38);padding:8px 2px;">No blockers set.</div>
                </div>
              </div>
              <!-- Search & select -->
              <div>
                <div class="dep-section-title">Add Blockers</div>
                <input class="dep-search-input" id="dep-search" type="text" placeholder="Search tasks to block on…">
                <div style="margin-top:8px;">
                  <div class="dep-task-list" id="dep-task-list"></div>
                </div>
              </div>
              <!-- Reverse view -->
              <div id="dep-reverse-section" style="display:none;">
                <div class="dep-section-title">This task Blocks</div>
                <div class="dep-also-blocks" id="dep-also-blocks"></div>
              </div>
            </div>
            <div class="dep-modal-footer">
              <button class="dep-save-btn" id="dep-save-btn">Save Dependencies</button>
              <button class="dep-cancel-btn" id="dep-cancel-btn">Cancel</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);

        overlay.addEventListener('click', e => { if (e.target === overlay) closeDepModal(); });
        document.getElementById('dep-close-btn').addEventListener('click', closeDepModal);
        document.getElementById('dep-cancel-btn').addEventListener('click', closeDepModal);
        document.getElementById('dep-save-btn').addEventListener('click', saveDepModal);
        document.getElementById('dep-search').addEventListener('input', _renderDepTaskList);
    }

    overlay.classList.add('visible');
    document.getElementById('dep-modal-task-name').textContent = `#${task.number} ${task.text}`;
    _renderDepCurrentList();
    _renderDepTaskList();
    _renderDepReverseView();
    setTimeout(() => document.getElementById('dep-search').focus(), 60);
}

function closeDepModal() {
    const overlay = document.getElementById('dep-modal-overlay');
    if (overlay) overlay.classList.remove('visible');
    _depModalTask = null;
}

function _renderDepCurrentList() {
    const el = document.getElementById('dep-current-list');
    if (!el) return;
    if (_depSelectedBlockers.size === 0) {
        el.innerHTML = '<div style="font-size:12px;color:rgba(196,181,253,0.38);padding:8px 2px;">No blockers set.</div>';
        return;
    }
    el.innerHTML = '';
    _depSelectedBlockers.forEach(bId => {
        const found = _findTaskById(bId);
        if (!found) return;
        const isDone = found.column === 'done';
        const row = document.createElement('div');
        row.className = 'dep-current-item';
        row.innerHTML = `
          <span class="dep-current-item-num">#${found.task.number}</span>
          <span class="dep-current-item-text">${found.task.text}</span>
          <span class="dep-current-item-status ${isDone ? 'done' : 'pending'}">${isDone ? '✓ Done' : '⏳ Pending'}</span>
          <button class="dep-remove-btn" data-id="${bId}" title="Remove blocker">✕</button>`;
        row.querySelector('.dep-remove-btn').addEventListener('click', e => {
            _depSelectedBlockers.delete(bId);
            _renderDepCurrentList();
            _renderDepTaskList();
        });
        el.appendChild(row);
    });
}

function _renderDepTaskList() {
    const el = document.getElementById('dep-task-list');
    const searchInput = document.getElementById('dep-search');
    if (!el) return;
    const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
    const all = _getAllTasks();
    // Exclude self
    const candidates = all.filter(t => t.id !== _depModalTask?.id);
    const filtered = query ? candidates.filter(t =>
        t.text.toLowerCase().includes(query) ||
        String(t.number).startsWith(query)
    ) : candidates;

    el.innerHTML = '';
    if (filtered.length === 0) {
        el.innerHTML = '<div style="font-size:12px;color:rgba(196,181,253,0.35);padding:10px 0;text-align:center;">No matching tasks</div>';
        return;
    }
    filtered.slice(0, 40).forEach(t => {
        const isSelected = _depSelectedBlockers.has(t.id);
        const row = document.createElement('div');
        row.className = 'dep-task-row' + (isSelected ? ' selected' : '');
        row.innerHTML = `
          <div class="dep-check">${isSelected ? '✓' : ''}</div>
          <span class="dep-task-row-num">#${t.number}</span>
          <span class="dep-task-row-text">${t.text}</span>
          <span class="dep-task-row-col ${t.column}">${t.column === 'todo' ? 'To Do' : t.column === 'working' ? 'Working' : 'Done'}</span>`;
        row.addEventListener('click', () => {
            if (_depSelectedBlockers.has(t.id)) _depSelectedBlockers.delete(t.id);
            else _depSelectedBlockers.add(t.id);
            _renderDepCurrentList();
            _renderDepTaskList();
        });
        el.appendChild(row);
    });
}

function _renderDepReverseView() {
    // Find tasks that list _depModalTask as a blocker
    const all = _getAllTasks();
    const blockedByMe = all.filter(t =>
        t.id !== _depModalTask?.id &&
        (t.blockedBy || []).includes(_depModalTask?.id)
    );
    const section = document.getElementById('dep-reverse-section');
    const el = document.getElementById('dep-also-blocks');
    if (!section || !el) return;
    if (blockedByMe.length === 0) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    el.innerHTML = blockedByMe.map(t =>
        `<span>Task <strong>#${t.number}</strong> "${t.text.slice(0,40)}" is waiting on this.</span>`
    ).join('<br>');
}

function saveDepModal() {
    if (!_depModalTask) return;
    const found = _findTaskById(_depModalTask.id);
    if (!found) { closeDepModal(); return; }
    found.task.blockedBy = [..._depSelectedBlockers];

    if (typeof saveAll === 'function') saveAll();
    if (typeof renderColumn === 'function') {
        renderColumn('todo');
        renderColumn('working');
        renderColumn('done');
    }
    closeDepModal();

    // Toast
    const count = found.task.blockedBy.length;
    if (typeof showToast === 'function') {
        showToast(count > 0 ? `🔗 ${count} blocker${count > 1 ? 's' : ''} set` : '🔗 Dependencies cleared', () => {});
    }
}

// ── Patch moveTaskWithUndo to block moving to "Working On" if blocked ──
function _patchMoveForDeps() {
    if (typeof moveTaskWithUndo !== 'function') { setTimeout(_patchMoveForDeps, 200); return; }
    const _origMove = moveTaskWithUndo;
    window.moveTaskWithUndo = moveTaskWithUndo = function(fromColumn, toColumn, taskId) {
        if (toColumn === 'working' && fromColumn === 'todo') {
            const found = _findTaskById(taskId);
            if (found && _isBlocked(found.task)) {
                const blockers = _getBlockerDetails(found.task).filter(b => !b.isDone);
                const names = blockers.slice(0, 2).map(b => `#${b.number}`).join(', ');
                if (typeof showToast === 'function') {
                    showToast(`🔒 Blocked by ${names}${blockers.length > 2 ? ' +' + (blockers.length-2) + ' more' : ''} — complete blockers first`, () => {});
                }
                return;
            }
        }
        _origMove(fromColumn, toColumn, taskId);

        // Auto-complete check: when moved to done, check if any tasks were waiting on this
        if (toColumn === 'done') {
            setTimeout(() => _checkAutoUnblock(taskId), 200);
        }
    };
}

function _checkAutoUnblock(completedTaskId) {
    // Find all tasks that were blocked by completedTaskId and check if now unblocked
    const all = _getAllTasks();
    all.forEach(t => {
        if (!(t.blockedBy || []).includes(completedTaskId)) return;
        if (!_isBlocked(t)) {
            // All blockers for this task are done — notify
            if (typeof showToast === 'function') {
                showToast(`✅ Task #${t.number} "${t.text.slice(0,30)}" is now unblocked!`, () => {});
            }
            // Re-render the card to remove blocked badge
            if (typeof renderColumn === 'function') renderColumn(t.column);
        }
    });
}

/* ─────────────────────────────────────────────────────────────────────────
   A. GLOBAL SEARCH  (Alt+R)
   ───────────────────────────────────────────────────────────────────────── */
let _gsOpen = false;
let _gsFocusIdx = -1;
let _gsItems = [];

function openGlobalSearch() {
    let overlay = document.getElementById('gs-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'gs-overlay';
        overlay.innerHTML = `
          <div id="gs-box">
            <div id="gs-input-row">
              <span class="gs-search-icon">🔍</span>
              <input id="gs-input" type="text" placeholder="Search tasks…" autocomplete="off" spellcheck="false">
              <span class="gs-kbd-hint">Esc to close</span>
            </div>
            <div id="gs-results"></div>
            <div class="gs-footer">
              <span><kbd>↑↓</kbd> navigate</span>
              <span><kbd>Enter</kbd> jump to task</span>
              <span><kbd>Alt+R</kbd> toggle</span>
            </div>
          </div>`;
        document.body.appendChild(overlay);

        overlay.addEventListener('click', e => { if (e.target === overlay) closeGlobalSearch(); });
        document.getElementById('gs-input').addEventListener('input', _gsRender);
        document.getElementById('gs-input').addEventListener('keydown', _gsKeyNav);
    }

    _gsOpen = true;
    _gsFocusIdx = -1;
    overlay.classList.add('visible');
    const input = document.getElementById('gs-input');
    input.value = '';
    _gsRender();
    setTimeout(() => input.focus(), 30);
}

function closeGlobalSearch() {
    const overlay = document.getElementById('gs-overlay');
    if (overlay) overlay.classList.remove('visible');
    _gsOpen = false;
    _gsFocusIdx = -1;
}

function _gsRender() {
    const input = document.getElementById('gs-input');
    const results = document.getElementById('gs-results');
    if (!input || !results) return;

    const query = input.value.trim().toLowerCase();
    const all = _getAllTasks();

    // Filter
    const filtered = query
        ? all.filter(t =>
            t.text.toLowerCase().includes(query) ||
            String(t.number) === query ||
            (t.dueDate && t.dueDate.includes(query))
          )
        : all;

    _gsItems = filtered;
    _gsFocusIdx = -1;

    if (filtered.length === 0) {
        results.innerHTML = `<div class="gs-empty">${query ? 'No tasks match "' + query + '"' : 'Start typing to search…'}</div>`;
        return;
    }

    // Group by column
    const colOrder = ['todo','working','done'];
    const colLabels = { todo: '📝 To Do', working: '⚡ Working On', done: '✅ Done' };
    const groups = {};
    filtered.forEach(t => {
        if (!groups[t.column]) groups[t.column] = [];
        groups[t.column].push(t);
    });

    let html = '';
    colOrder.forEach(col => {
        if (!groups[col] || groups[col].length === 0) return;
        html += `<div class="gs-section-hdr">${colLabels[col]} (${groups[col].length})</div>`;
        groups[col].forEach((t, idx) => {
            const priIcon = t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢';
            const isBlocked = _isBlocked(t);
            const textDisplay = query
                ? t.text.replace(new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'gi'), '<mark>$1</mark>')
                : t.text;
            html += `<div class="gs-item" data-task-id="${t.id}" data-column="${t.column}">
              <span class="gs-item-num">#${t.number}</span>
              <span class="gs-item-pri" title="${t.priority}">${priIcon}${isBlocked ? '🔒' : ''}</span>
              <span class="gs-item-text">${textDisplay}</span>
              <span class="gs-item-col ${t.column}">${colLabels[col].split(' ').slice(1).join(' ')}</span>
            </div>`;
        });
    });

    results.innerHTML = html;
    results.querySelectorAll('.gs-item').forEach((el, idx) => {
        el.addEventListener('click', () => _gsJumpTo(idx));
        el.addEventListener('mouseenter', () => { _gsFocusIdx = idx; _gsHighlight(); });
    });
}

function _gsHighlight() {
    const items = document.querySelectorAll('#gs-results .gs-item');
    items.forEach((el, i) => el.classList.toggle('gs-focused', i === _gsFocusIdx));
    if (_gsFocusIdx >= 0 && items[_gsFocusIdx]) {
        items[_gsFocusIdx].scrollIntoView({ block: 'nearest' });
    }
}

function _gsKeyNav(e) {
    const items = document.querySelectorAll('#gs-results .gs-item');
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _gsFocusIdx = Math.min(_gsFocusIdx + 1, items.length - 1);
        _gsHighlight();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _gsFocusIdx = Math.max(_gsFocusIdx - 1, 0);
        _gsHighlight();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_gsFocusIdx >= 0) _gsJumpTo(_gsFocusIdx);
        else if (_gsItems.length > 0) _gsJumpTo(0);
    } else if (e.key === 'Escape') {
        closeGlobalSearch();
    }
}

function _gsJumpTo(idx) {
    const t = _gsItems[idx];
    if (!t) return;
    closeGlobalSearch();
    // Select the task and scroll it into view
    setTimeout(() => {
        if (typeof selectTask === 'function') selectTask(t.column, t.id);
        if (typeof scrollTaskIntoView === 'function') scrollTaskIntoView(t.id);
        else {
            const card = document.getElementById('task-' + t.id);
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 80);
}

// ── Register Alt+R keyboard shortcut ──
document.addEventListener('keydown', e => {
    // Alt+R to open search
    if ((e.key === 'r' || e.key === 'R') && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (_gsOpen) closeGlobalSearch();
        else openGlobalSearch();
        return;
    }
    // Escape closes search if open
    if (e.key === 'Escape' && _gsOpen) {
        e.stopPropagation();
        closeGlobalSearch();
        return;
    }
}, true);

// Expose global
window.openGlobalSearch = openGlobalSearch;
window.closeGlobalSearch = closeGlobalSearch;

/* ─────────────────────────────────────────────────────────────────────────
   BOOT — run patches once DOM + scripts are loaded
   ───────────────────────────────────────────────────────────────────────── */
function _boot() {
    _patchCreateTaskCard();
    _patchMoveForDeps();
    _patchCommentPanel();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(_boot, 400));
} else {
    setTimeout(_boot, 400);
}

})(); // end IIFE
