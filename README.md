# Tasky

A beautiful, keyboard-first task tracker with three Kanban-style panels. Just start typing.

Live at https://touhidsiddiqueeraj-bit.github.io/tasky/

<img width="1901" height="952" alt="image" src="https://github.com/user-attachments/assets/84c3815a-8058-4074-8154-3dfbd444add9" />

## File Structure

```
tasky/
├── index.html   — Markup only (HTML structure + inline CSS/JS)
├── tasky.css    — All styles, animations, themes, responsive layout
├── tasky.js     — All logic: state, rendering, keyboard, voice, drag & drop, Firebase
├── README.md
└── CONTRIBUTING.md
```

## Features

- **Three columns** — To Do / Working On / Done
- **Keyboard-first** — any letter/number opens the input, no clicking required
- **Task Groups** — create reusable task templates, expand onto the board by typing the group name
- **Voice input** — hold Space to dictate (Chrome/Edge/Brave, mic required)
- **Drag & drop** — reorder and move tasks between columns
- **Priority system** — High 🔴 / Medium 🟡 / Low 🟢, with per-column filters
- **Due dates** — pick a date per task; overdue ones highlighted in red
- **Undo** — 3-second undo toast on delete and move
- **Dark / Light mode** — persisted via localStorage
- **Custom background** — upload any image; animated orbs float on top
- **Task card opacity** — slider (40–100%) controls card transparency against your background
- **CSV export** — all tasks with status, priority, and dates
- **Cloud sync (optional)** — sign in with Google to sync across devices (Firebase)
- **Quick navigation** — Alt+1–9 to select, Alt+G to jump by number
- **Task selector** — type a task number to find and select it instantly
- **Mobile FAB** — floating Add + mic buttons on small screens
- **No install** — everything in localStorage, works offline

## Keyboard Shortcuts

| Key | Context | Action |
|---|---|---|
| Any letter/number | Board | Open floating input |
| `Enter` | Input | Save task |
| `Esc` | Input | Cancel & close input |
| `Esc` | Selected task | Deselect task |
| `←` | Selected task | Move to previous column |
| `→` | Selected task | Move to next column |
| `1` | Selected task | Set priority **High** 🔴 |
| `2` | Selected task | Set priority **Medium** 🟡 |
| `3` | Selected task | Set priority **Low** 🟢 |
| `Delete` / `Backspace` | Selected task | Delete task (with undo) |
| `Alt`+`1`–`9` | Board | Select task by number |
| `Alt`+`G` | Board | Enter goto mode — type a number + `Enter` to jump |
| `0`–`9` | Goto mode | Build the task number |
| `Enter` | Goto mode | Jump to the typed task number |
| `Backspace` | Goto mode | Erase last digit |
| `Esc` | Goto mode | Exit goto mode |
| Hold `Space` | Board | Voice dictation (desktop Chrome/Edge/Brave) |
| `↑` / `↓` | TG suggestion | Navigate group suggestions |
| `Enter` | TG suggestion | Expand selected group onto the board |

## Task Groups

Click **Tasky ▼ → Task Groups** to open the task groups modal. Create reusable templates:

1. **Name** the group (e.g. "Sprint Setup", "Morning Routine")
2. **Choose** a target column (To Do or Working On)
3. **Add tasks** with optional priorities
4. **Save** — the group is stored as a template

When you start typing in the main input, group names matching what you've typed appear as suggestions. Press `↑`/`↓` to navigate and `Enter` to expand the entire group onto the board instantly. Duplicate tasks (by text) are skipped automatically.

Task Groups survive data resets and are synced to the cloud when signed in.

## Background

Click **🖼️ Background** in the dropdown menu to open the background settings modal:

1. **Choose Image** — upload a JPEG/PNG as wallpaper. The image sits behind the animated orbs with a semi-transparent overlay for readability.
2. **Remove** — clears the custom background and reverts to default.
3. **Opacity** — adjust task card opacity (40–100%) so the background shows through at your preferred level.

Settings are saved to `localStorage` and restored on reload.

## How to Run

1. Serve locally (required for Firebase auth):
   ```
   python3 -m http.server 8080
   ```
2. Open http://localhost:8080 in a browser.
3. For voice input, Chrome, Edge, or Brave is required.

Alternatively, open `index.html` directly — all features except cloud sync will work.

*Note: Voice input uses the Web Speech API, which requires the tab to be in the foreground.*

## Cloud Sync (optional)

Sign in with Google from **Tasky ▼** to sync your tasks across devices. Data is stored in Cloud Firestore (Firebase). Works offline — changes are queued locally and sync when you're back online.

- **Privacy**: Only your tasks and an auto-generated counter are sent to Firestore. No analytics, no tracking, no third-party access.
- Task Groups are preserved on data reset and synced to the cloud.

## Data & Privacy

All data is stored in your browser's `localStorage` and optionally synced to Firebase Firestore when signed in. Nothing is sent to any other server. Clearing site data will erase your tasks — export to CSV first if you need a backup.

## Browser Support

| Browser | Tasks | Voice | Cloud Sync |
|---|---|---|---|
| Chrome 90+ | ✅ | ✅ | ✅ |
| Edge 90+ | ✅ | ✅ | ✅ |
| Brave | ✅ | ✅ | ✅ |
| Firefox | ✅ | ❌ | ✅ |
| Safari | ✅ | ⚠️ (partial) | ✅ |

## Customisation

CSS custom properties at the top of `tasky.css`:

```css
:root {
    --todo-color:    #8B5CF6;   /* purple */
    --working-color: #F59E0B;   /* amber  */
    --done-color:    #10B981;   /* green  */
}
```

Change these to retheme the column rings, orbs, and accents in one go.
