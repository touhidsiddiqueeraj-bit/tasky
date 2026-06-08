# Contributing to Tasky

Thanks for your interest! Tasky is a single-page vanilla JS app with no build step — easy to hack on.

## Getting Started

1. Fork and clone the repo.
2. Serve the project root:
   ```bash
   python3 -m http.server 8080
   ```
3. Open http://localhost:8080.
4. Make your changes and hard-refresh (`Ctrl+Shift+R`) to bypass the browser cache.

## Code Style

- **No build tools, no bundlers, no npm.** All source files live in the project root and are loaded via `<script defer>` in `index.html`.
- **Vanilla JS only.** No frameworks, no imports, no modules. Everything is in the global scope.
- **Firebase 10.12.0 compat** — loaded from CDN in `index.html`. Use `firebase.xxx()` compat API.
- **`let` over `var`** for state variables. Use `var` only in the inline `<script>` block.
- **No comments in code** unless the logic is genuinely non-obvious.
- **Single quotes** for strings.
- **4-space indentation** (JS, CSS, HTML). The existing code uses mixed indentation — keep your additions consistent with the surrounding code.
- **Debug logging**: use `_log(...)` instead of `console.log(...)`. Set `window.DEBUG = true` in the console to enable verbose logging.

## Source Files

| File | Role |
|---|---|
| `index.html` | HTML structure + inline boot scripts |
| `tasky.css` | Core styles |
| `tasky.js` | Core app logic: workspaces, tasks, drag-drop, keyboard, auth, encryption |
| `tasky-collab.js` | Team collaboration: groups, supervisors, members, message board, notifications |
| `tasky-features.js` | Feature flags, settings panel, calendar wiring |
| `tasky-calendar.js` + `.css` | Calendar view |
| `tasky-voice.js` + `.css` | WebRTC voice calls, signaling, ring, mute/deafen |
| `tasky-video.js` + `.css` | Video calls, screen share, recording, PiP, video grid |
| `tasky-whiteboard.js` + `.css` | Shared canvas with RTC DataChannel + Firestore sync |
| `tasky-palette.js` | Command palette (Ctrl+K) |
| `tasky-bulk.js` | Bulk task operations |
| `tasky-activity.js` | Activity feed |
| `tasky-subtask.js` | Subtask support |
| `tasky-timer.js` + `.css` | Pomodoro / stopwatch timers |
| `tasky-deps-search.js` | Global search, task dependencies, Markdown renderer |
| `sw.js` | Service worker for PWA offline support |

## Pull Request Process

1. Keep changes focused. A PR should address one feature or bug.
2. Test manually:
   - Task creation, deletion, undo, drag-drop.
   - Keyboard shortcuts (all of them).
   - Voice input (if applicable).
   - Dark/light mode toggle.
   - Background upload + remove + opacity slider.
   - Task Groups create/edit/expand.
   - Mobile viewport (responsive breakpoint at 768px).
3. Verify the app doesn't crash in the browser console.
4. Open a PR against `main` with a concise description of what you changed and why.

## Architecture Notes

- **State** is declared at the top of `tasky.js` as `let` variables. Changes are persisted to `localStorage` immediately.
- **Rendering** (`renderAllColumns`) is destructive — it rebuilds all task cards from the `tasks` object.
- **Keyboard** has two layers: an input `keydown` listener (for the floating input) and a document `keydown` listener (for global shortcuts). The Task Groups suggestion handler runs in the capture phase on `document` so it fires before `setupKeyboard`.
- **Firebase** uses the compat SDK (`firebase.xxx()`). Auth and Firestore are set up lazily — if the user never signs in, no network requests are made.
- **Custom background** is stored as a data URL in `localStorage` under `customBg`. The image is rendered in a fixed layer (`z-index: -1`) with a semi-transparent overlay on top.
- **Module loading order** is critical — scripts are loaded via `<script defer>` in this sequence: tasky.js → tasky-collab.js → tasky-features.js → tasky-calendar.js → ... → tasky-voice.js → tasky-video.js → tasky-whiteboard.js → ... Each file assumes previous ones have run.

## Questions?

Open an issue or start a discussion on GitHub.
