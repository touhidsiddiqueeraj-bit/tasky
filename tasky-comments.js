(function() {
var style = document.createElement('style');
style.textContent = `
.cmt-toggle { background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:12px;padding:0 6px; }
.cmt-toggle:hover { color:#a78bfa; }
.cmt-container { padding:4px 10px 8px 28px;border-top:1px solid rgba(255,255,255,0.06);margin-top:4px;max-height:260px;overflow-y:auto; }
.cmt-row { display:flex;gap:6px;padding:4px 0;align-items:flex-start; }
.cmt-avatar { width:22px;height:22px;border-radius:50%;background:#8B5CF6;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;flex-shrink:0; }
.cmt-body { flex:1;min-width:0; }
.cmt-meta { font-size:10px;color:rgba(255,255,255,0.35);display:flex;gap:6px;align-items:center; }
.cmt-author { font-weight:600;color:rgba(255,255,255,0.6); }
.cmt-time { color:rgba(255,255,255,0.25); }
.cmt-text { font-size:12px;color:rgba(255,255,255,0.8);margin:1px 0 0;word-break:break-word;line-height:1.4; }
.cmt-input-row { display:flex;gap:6px;padding:6px 0 0 0;align-items:center; }
.cmt-input { flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:rgba(255,255,255,0.8);font-size:12px;padding:5px 8px;outline:none; }
.cmt-input:focus { border-color:#8B5CF6; }
.cmt-input::placeholder { color:rgba(255,255,255,0.25); }
.cmt-send { background:#8B5CF6;border:none;border-radius:6px;color:#fff;font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer;flex-shrink:0; }
.cmt-send:hover { background:#7C3AED; }
.cmt-send:disabled { opacity:0.4;cursor:default; }
.cmt-empty { font-size:11px;color:rgba(255,255,255,0.3);padding:4px 0;text-align:center; }

body.light-mode .cmt-toggle { color:rgba(0,0,0,0.3); }
body.light-mode .cmt-container { border-top-color:rgba(0,0,0,0.08); }
body.light-mode .cmt-text { color:rgba(0,0,0,0.7); }
body.light-mode .cmt-meta { color:rgba(0,0,0,0.25); }
body.light-mode .cmt-author { color:rgba(0,0,0,0.5); }
body.light-mode .cmt-time { color:rgba(0,0,0,0.2); }
body.light-mode .cmt-input { background:rgba(0,0,0,0.04);border-color:rgba(0,0,0,0.12);color:rgba(0,0,0,0.8); }
body.light-mode .cmt-empty { color:rgba(0,0,0,0.2); }
`;
document.head.appendChild(style);
})();

var _origCMCreateTaskCard = createTaskCard;
createTaskCard = function(task, column) {
    var card = _origCMCreateTaskCard(task, column);
    var hoverControls = card.querySelector('.task-hover-controls');
    if (!hoverControls) return card;

    var cmtBtn = document.createElement('button');
    cmtBtn.className = 'cmt-toggle';
    cmtBtn.title = 'Comments';
    cmtBtn.textContent = '💬';
    cmtBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var container = card.querySelector('.cmt-container');
        if (container) {
            container.style.display = container.style.display === 'none' ? '' : 'none';
        }
    });
    hoverControls.appendChild(cmtBtn);

    var container = document.createElement('div');
    container.className = 'cmt-container';
    container.style.display = 'none';
    container.id = 'cmt-' + task.id;
    _cmtRender(container, task);
    card.appendChild(container);

    return card;
};

function _cmtRender(container, task) {
    var comments = _cmtGetComments(task.id);
    container.innerHTML = '';
    if (!comments || comments.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'cmt-empty';
        empty.textContent = 'No comments yet';
        container.appendChild(empty);
    } else {
        comments.forEach(function(c) {
            var row = document.createElement('div');
            row.className = 'cmt-row';
            var avatar = c.author ? c.author[0].toUpperCase() : '?';
            var ts = c.createdAt ? _cmtTimeAgo(c.createdAt) : '';
            row.innerHTML = '<div class="cmt-avatar">' + avatar + '</div><div class="cmt-body"><div class="cmt-meta"><span class="cmt-author">' + escapeHtml(c.author || 'Anonymous') + '</span><span class="cmt-time">' + ts + '</span></div><div class="cmt-text">' + _cmtRenderText(c.text) + '</div></div>';
            container.appendChild(row);
        });
    }
    var inputRow = document.createElement('div');
    inputRow.className = 'cmt-input-row';
    inputRow.innerHTML = '<input type="text" class="cmt-input" placeholder="Write a comment…" data-cmt-input="' + task.id + '"><button class="cmt-send" data-cmt-send="' + task.id + '">Send</button>';
    container.appendChild(inputRow);

    var input = inputRow.querySelector('.cmt-input');
    var sendBtn = inputRow.querySelector('.cmt-send');
    function sendComment() {
        var text = input.value.trim();
        if (!text) return;
        _cmtAddComment(task.id, text);
        input.value = '';
        _cmtRender(container, _stFindTask(task.id) || task);
    }
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); sendComment(); }
    });
    sendBtn.addEventListener('click', sendComment);
}

function _cmtGetComments(taskId) {
    if (typeof currentGroup !== 'undefined' && currentGroup && typeof loadCommentEntries === 'function') {
        // Delegate to collab's loadCommentEntries — but that's async and needs Firestore.
        // For the inline display we'll use local cache and piggyback on collab.
        var key = 'tasky_comments_' + taskId;
        try { return JSON.parse(localStorage.getItem(key)) || []; } catch(e) { return []; }
    }
    var key = 'tasky_comments_' + taskId;
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch(e) { return []; }
}

function _cmtAddComment(taskId, text) {
    var entry = { id: Date.now() + Math.random(), text: text, author: typeof currentHandle !== 'undefined' && currentHandle ? currentHandle : 'Me', createdAt: new Date().toISOString() };
    var key = 'tasky_comments_' + taskId;
    var comments = [];
    try { comments = JSON.parse(localStorage.getItem(key)) || []; } catch(e) {}
    comments.push(entry);
    localStorage.setItem(key, JSON.stringify(comments));
}

function _cmtRenderText(text) {
    if (typeof renderMarkdown === 'function') return renderMarkdown(text);
    return escapeHtml(text).replace(/\n/g, '<br>');
}

function _cmtTimeAgo(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    return days + 'd ago';
}

// Re-render comments when collab sync fires
if (typeof window.addEventListener === 'function') {
    window.addEventListener('tasky:commentsync', function() {
        document.querySelectorAll('.cmt-container[id^="cmt-"]').forEach(function(container) {
            var taskId = parseInt(container.id.replace('cmt-', ''));
            var task = _stFindTask(taskId);
            if (task) _cmtRender(container, task);
        });
    });
}
