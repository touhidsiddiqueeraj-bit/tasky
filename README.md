# Tasky

A beautiful, minimalist task tracker with three Kanban-style panels. Just start typing.

Live at https://touhidsiddiqueeraj-bit.github.io/tasky/

<img width="1901" height="952" alt="image" src="https://github.com/user-attachments/assets/84c3815a-8058-4074-8154-3dfbd444add9" />

## File Structure

tasky/
├── index.html   — Markup only (HTML structure)
├── tasky.css    — All styles, animations, themes, responsive layout
├── tasky.js     — All logic: state, rendering, keyboard, voice, drag & drop, Firebase cloud sync
└── README.md

## Features

- Three columns — To Do / Working On / Done
- Keyboard-first — type anywhere to add a task, no clicking required
- Voice input — hold Space to dictate (Chrome/Edge/Brave, mic required)
- Drag & drop — reorder and move tasks between columns
- Priority system — High 🔴 / Medium 🟡 / Low 🟢, with per-column filters
- Due dates — overdue tasks highlighted in red
- Undo — 3-second undo toast on delete and move
- Dark / Light mode — persisted via localStorage
- Custom background — upload any image, animated orbs float on top
- Task card opacity — slider adjusts card transparency against your background
- CSV export — all tasks with status, priority, and dates
- Cloud sync — sign in with Google to sync tasks across devices (Firebase)
- Quick task selection — Alt+1–9 to select, Alt+G to search by number
- Mobile FAB — floating Add + mic buttons on small screens
- No install — everything in localStorage, works offline and syncs when online

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Any letter/number | Open floating input to add a task |
| Enter | Save task |
| Esc | Cancel input / deselect task |
| Click a task | Select it |
| ← → | Move selected task between columns |
| 1 2 3 | Set priority High / Medium / Low on selected task |
| Delete | Delete selected task (with undo) |
| Alt+1–9 | Select task by number |
| Alt+G | Enter goto mode (type number + Enter) |
| Hold Space | Voice dictation (desktop only) |

## Background

Click **🖼️ Background** in the dropdown menu to open the background settings modal:

1. **Choose Image** — upload a JPEG/PNG as your wallpaper. The image sits behind the animated orbs with a semi-transparent overlay for readability.
2. **Remove** — clears the custom background and reverts to the default dark/light gradient.
3. **Opacity** — adjust task card opacity from 40% to 100% so the background shows through at your preferred level.

Settings are saved to `localStorage` and restored on reload.

## How to Run

1. Serve via HTTP (required for Firebase auth):
   ```
   python3 -m http.server 8080
   ```
2. Open http://localhost:8080 in a browser
3. For voice input, Chrome, Edge, or Brave is required.

Alternatively, just open `index.html` directly — all features except cloud sync will work.

*Note: Voice input uses the Web Speech API, which requires the tab to be in the foreground. If you alt-tab while holding Space, the listening session ends automatically.*

## Cloud Sync (optional)

Sign in with Google from the Tasky menu to sync your tasks across devices. Data is stored in Cloud Firestore (Firebase) and works with offline persistence — changes are queued locally and sync when you're back online.

*Privacy: Only your tasks and an auto-generated task counter are sent to Firestore. No analytics, no tracking, no third-party access.*

## Data & Privacy

All data is stored in your browser's `localStorage` and optionally synced to Firebase Firestore when signed in. Nothing is sent to any other server. Clearing site data or browser storage will erase your tasks — export to CSV first if you need a backup.

## Browser Support

| Browser | Tasks | Voice | Cloud Sync |
|---|---|---|---|
| Chrome 90+ | ✅ | ✅ | ✅ |
| Edge 90+ | ✅ | ✅ | ✅ |
| Brave | ✅ | ✅ | ✅ |
| Firefox | ✅ | ❌ (no Web Speech API) | ✅ |
| Safari | ✅ | ⚠️ (partial, may need permission reset) | ✅ |

## Customisation

All CSS custom properties are at the top of `tasky.css`:

```css
:root {
    --todo-color:    #8B5CF6;   /* purple */
    --working-color: #F59E0B;   /* amber  */
    --done-color:    #10B981;   /* green  */
}
```

Change these to retheme the column rings, orbs, and accents in one go.
