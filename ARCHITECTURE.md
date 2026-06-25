# Architecture

Tasky is a single-page vanilla JS app. All code shares the global scope — no modules, no bundlers.

## File loading order

Scripts are loaded via `<script defer>` in index.html. Order is critical:

1. **tasky.js** — core app: workspaces, tasks, keyboard, drag-drop, auth, encryption, Firebase init
2. **tasky-collab.js** — team collaboration: groups, supervisors, members, message board, notifications, comments
3. **tasky-features.js** — feature flags, settings panel, calendar wiring, recurring tasks
4. **tasky-calendar.js** — calendar view (replaces stub from features.js)
5. **tasky-deps-search.js** — global search, task dependency graph, Markdown renderer
6. **tasky-subtask.js** — subtask UI per task card
7. **tasky-timer.js** — Pomodoro/stopwatch timers per task
8. **tasky-bulk.js** — bulk select/move/delete operations
9. **tasky-activity.js** — activity feed panel
10. **tasky-palette.js** — command palette (Ctrl+K)
11. **tasky-voice.js** — WebRTC voice calls: signaling, ring, mute/deafen, participant panel
12. **tasky-video.js** — video calls: camera, screen share, recording, PiP, video grid
13. **tasky-whiteboard.js** — shared canvas (RTC DataChannel + Firestore archive)

## Global state

All modules share top-level `let`/`var` declarations. Cross-module access uses `window.*` exports and implicit globals (e.g., `currentGroup`, `db`, `tasks`).

### Key globals

| Symbol | Set by | Read by | Description |
|---|---|---|---|
| `tasks` | tasky.js | everything | `{ todo: [], working: [], done: [] }` |
| `currentUser` | tasky.js | collab, voice, video | Firebase Auth user |
| `db` | tasky.js | collab, voice, video, whiteboard | Firestore instance |
| `currentGroup` | collab.js | voice, video, whiteboard | Active collab group |
| `workspaces` | tasky.js | tasky.js, collab.js | Workspace list |
| `activeWorkspaceId` | tasky.js | tasky.js, collab.js | Active workspace |

### window.* exports

Modules export functions to `window` for cross-module invocation:

| Export | Defined in | Used by |
|---|---|---|
| `switchWorkspace` | tasky.js | collab.js, palette.js |
| `renderAllColumns` | tasky.js | collab.js, subtask.js, timer.js |
| `createTaskCard` | tasky.js | subtask.js, timer.js, collab.js (via `_cardModifiers`) |
| `renderGroupUI` | collab.js | tasky.js, voice.js, video.js |
| `vcJoin` / `vcLeave` | voice.js | collab.js, video.js, UI buttons |
| `vvToggleCamera` / `vvToggleScreen` | video.js | video controls |
| `openWhiteboard` / `closeWhiteboard` | whiteboard.js | video grid toolbar |

## Card modifier system

Instead of monkey-patching `createTaskCard`, modules register modifiers:

```
window._cardModifiers.push(function(card, task, column) {
    // modify card in place
});
```

Registered by: subtask.js, timer.js, collab.js. Runs at the end of `createTaskCard()`.

## Voice/Video call flow

```
vcJoin() → getUserMedia → write presence to Firestore → start listeners
  └─ participants listener detects new peer → lower-uid creates WebRTC offer
      └─ vvToggleCamera/vvToggleScreen → addTrack/replaceTrack → renegotiate
```

Signaling via Firestore `voice_sessions/{groupCode}/signals` subcollection.

## Whiteboard sync

- **Live**: RTC DataChannel via existing call PeerConnections
- **Archive**: Firestore batch write every 3s
- **Fallback (no call)**: Direct Firestore writes (same as old behavior)
- **Late joiners**: One-time Firestore `get()` on open

## Debug logging

Set `window.DEBUG = true` in the console to enable verbose `_log()` output. All production `console.log` calls have been replaced with `_log()`.

## Event-driven wiring

Modules use function wrapping/patching:
- `renderGroupUI` → patched by voice.js, video.js to inject call buttons
- `leaveGroup` → patched by voice.js to leave call
- `createTaskCard` → modifiers (see above)

## Key design decisions

- **No build step**: Zero npm, open index.html directly
- **Firebase compat SDK**: `firebase.xxx()` API loaded from CDN
- **Read-only share**: `?view=CODE` query param loads board without auth
- **Encryption**: AES-GCM via Web Crypto API, transparent to rest of app
- **PWA**: Service worker caches all source files, skip-waiting on activate
