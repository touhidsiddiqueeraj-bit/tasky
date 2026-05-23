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

- **No build tools, no bundlers, no npm.** Everything lives in three files:
  - `index.html` — HTML structure + inline `<style>` and some inline `<script>` for boot logic.
  - `tasky.css` — all styles.
  - `tasky.js` — all application logic.
- **Vanilla JS only.** No frameworks, no imports, no modules. Everything is in the global scope.
- **Firebase 10.12.0 compat** — loaded from CDN in `index.html`. Use `firebase.xxx()` compat API.
- **`let` over `var`** for state variables. Use `var` only in the inline `<script>` block.
- **No comments in code** unless the logic is genuinely non-obvious.
- **Single quotes** for strings.
- **4-space indentation** (JS, CSS, HTML). The existing code uses mixed indentation — keep your additions consistent with the surrounding code.

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

## Questions?

Open an issue or start a discussion on GitHub.
