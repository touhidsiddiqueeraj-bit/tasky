# Tasky

A beautiful, keyboard-first task tracker with three Kanban-style panels. Just start typing.

Live at https://touhidsiddiqueeraj-bit.github.io/tasky/

<img width="1901" height="952" alt="image" src="https://github.com/user-attachments/assets/84c3815a-8058-4074-8154-3dfbd444add9" />

## File Structure

```
tasky/
├── index.html            — Markup, inline boot logic, PWA meta, Firebase CDN
├── manifest.json         — PWA manifest (standalone display, SVG icons)
├── tasky.css             — All styles, animations, themes, responsive layout
├── tasky.js              — Core logic: state, rendering, keyboard, drag & drop, Firebase, encryption
├── tasky-collab.js       — Collaboration layer: groups, supervisor, task assignment, comments
├── tasky-voice.js        — WebRTC mesh voice calls via Firestore signaling
├── tasky-voice.css       — Voice call UI styles
├── tasky-features.js     — Extended features: recurring tasks, CSV import, @mentions, supervisor locks, tab-cycle
├── tasky-calendar.js     — Full calendar: monthly/weekly views, drag-to-reschedule, keyboard navigation
├── tasky-calendar.css    — Calendar panel styles
├── README.md
├── CONTRIBUTING.md
└── LICENSE
```

## Features

- **Three columns** — To Do / Working On / Done
- **Keyboard-first** — any letter/number opens the input, no clicking required
- **Task Groups** — create reusable task templates, expand onto the board by typing the group name
- **Voice input** — hold Space to dictate (Chrome/Edge/Brave, mic required)
- **Drag & drop** — reorder and move tasks between columns (desktop + mobile touch)
- **Priority system** — High 🔴 / Medium 🟡 / Low 🟢, with per-column filters
- **Due dates** — pick a date per task; overdue ones highlighted in red
- **Undo** — 3-second undo toast on delete and move
- **Dark / Light mode** — toggle in the Settings panel, persisted via localStorage
- **Custom background** — upload any image from the Settings panel; animated orbs float on top
- **Column glass opacity** — slider (40–100%) controls column background transparency, keeping the frosted-glass effect
- **Accent colour** — 6 presets + custom colour picker in Settings
- **Typography** — font family (6 options), font size (11–20px), and task text colour in Settings
- **Workspaces** — create multiple independent workspaces, each with its own task board, counter, and optional collaboration link. Switch between them instantly via the top pill bar
- **CSV export** — all tasks with status, priority, and dates
- **Due date notifications** — browser push notifications for upcoming dates
- **Cloud sync (optional)** — sign in with Google to sync across devices (Firebase Firestore)
- **Team Collaboration** — supervisor creates a group, members join with a 6-character code; assign tasks, add comments, activity feed
- **Read-only share board** — clients can view a live read-only board without signing in
- **Quick navigation** — Alt+1–9 to select, Alt+G to jump by number
- **Task selector** — type a task number to find and select it instantly
- **Mobile FAB** — floating Add + mic buttons on small screens
- **No install** — everything in localStorage, works offline
- **Local encryption** — all task data encrypted at rest with AES-256-GCM + PBKDF2 passphrase; optional, toggled from Settings
- **Recurring tasks** — set daily, weekly, or monthly recurrence on any task; auto-duplicates when completed on the due date
- **Calendar view** — monthly/weekly calendar showing all tasks with due dates; drag chips to reschedule, color-coded by status
- **CSV import** — import tasks from a CSV file via the Settings panel
- **@Mentions** — mention team members in task comments with autocomplete (`@username`) and Firestore notification
- **Supervisor-only controls** — restrict task assignment and deletion to the collaboration supervisor
- **Tab-cycle workspaces** — press Tab to cycle through open workspaces
- **Voice calls** — peer-to-peer voice calls between collab members via WebRTC mesh with Firestore signaling
- **PWA ready** — installable as a Progressive Web App with standalone display, SVG icons, and offline support

## Settings Panel

Open **Tasky ▼ → Settings** (⚙️) to customise the app:

### Appearance
- **Theme** — toggle Light / Dark mode
- **Accent Colour** — 6 preset swatches (Purple, Blue, Green, Amber, Red, Pink) or a custom colour picker. Applies to buttons, slider thumbs, and highlights.
- **Background Image** — upload a JPEG/PNG as wallpaper. The image sits behind animated orbs with a semi-transparent overlay for readability.
- **Card Opacity** — controls the glass transparency of the three column cards (40–100%). The frosted-glass blur effect is preserved at every level.

### Typography
- **Font Family** — System, Inter, DM Sans, Fira Code, Georgia, or Courier
- **Font Size** — task text size from 11px to 20px
- **Task Text Colour** — 5 presets (Lavender, White, Slate, Yellow, Mint) or custom colour

### System
- **Due Date Notifications** — enable browser push notifications
- **Export Tasks as CSV** — downloads all tasks with number, text, status, priority, due date, and creation date
- **How to Use** — reopens the onboarding walkthrough
- **Encryption** — set a passphrase to encrypt all task data in `localStorage` at rest. AES-256-GCM with PBKDF2 key derivation (100k iterations, SHA-256). Unlock with the same passphrase on return. Change or disable at any time. **If you forget your passphrase, data cannot be recovered.**
- **Reset All Data** — deletes all tasks and resets everything (requires confirmation)

All settings are saved to `localStorage` and restored on reload.

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

## Workspaces

Tasky supports multiple **workspaces** — independent task boards that live side‑by‑side. Each workspace has its own tasks, task counter, and optional collaboration link.

- **Personal** — the default workspace (id: 1). Cannot be deleted.
- **Create a workspace** — click **＋ New Workspace** in the top bar to add an empty workspace and switch to it immediately.
- **Switch workspaces** — click any pill in the top bar. The board fades out and back in with the new workspace's tasks.
- **Delete a workspace** — hover over a workspace pill (except Personal) and click **✕**. If it has tasks, a confirmation dialog appears.
- **Collaboration per workspace** — creating or joining a collaboration automatically links it to the active workspace. The collab code is stored in the workspace's metadata.
- **Isolation** — workspaces are stored separately in `localStorage` (`ws_tasks_{id}` / `ws_counter_{id}`) and synced independently to Firestore.

The "Personal" workspace always exists. Additional workspaces are named "Workspace 2", "Workspace 3", etc. by default, or after a collaboration name.

## Team Collaboration

Click **Tasky ▼ → Create Collaboration** to become a supervisor:

1. A **6-character code** is generated — share it with your team.
2. Team members click **Join Collaboration** and enter the code to join.
3. The supervisor sees a **Team column** (teal accent) on the board.
4. **Assign tasks** to team members from the task menu. Assigned tasks appear in both the assignee's column and the Team column.
5. **Comments & activity** — each task has a comment feed visible to all group members. Activity updates (assignments, moves, completions) appear in real time.
6. **Read-only board** — clients can view a live read-only board without signing in (useful for stakeholders).

Data is synced in real time via Firebase Firestore.

## Calendar View

Click the calendar icon (📅) in the **To Do** column header to open the calendar overlay.

- **Monthly / Weekly** — toggle between month and week views via the header buttons
- **Color-coded** — tasks are colored by status: purple (To Do), amber (Working On), green (Done)
- **Drag to reschedule** — drag a task chip to a new date; the task's `dueDate` updates instantly
- **Collaboration sync** — shows assigned team member avatars on task chips
- **Navigation** — `←`/`→` previous/next day, `↑`/`↓` ±7 days, `M` month view, `W` week view, `T` go to today, `Alt+M` open calendar, `Esc` close
- **Keyboard focus** — arrow keys move focus across days; focused date is highlighted

All tasks with a `dueDate` appear on their corresponding day. The calendar pulls from both personal and collaboration tasks.

## Recurring Tasks

Set a task to repeat **daily**, **weekly**, or **monthly** from its task menu:

1. Click **↻ Recur** on any task card's menu.
2. Choose **Daily**, **Weekly**, or **Monthly**.
3. A badge appears on the card showing the recurrence interval.
4. When you move the task to **Done** on or after its due date, a duplicate is created automatically with the next due date.
5. Manage all recurring tasks from **Settings → Recurring Manager** — view, edit, or delete recurrence rules.

Recurring tasks sync to the cloud when signed in.

## Voice Calls

Collaboration members can call each other directly from the board:

- **Start a call** — click the **📞 Call** button in the collaboration panel. All online group members receive a ring notification.
- **Incoming call** — a modal appears with **Accept** / **Decline** options; auto-declines after 30 seconds.
- **Mute / Deafen** — toggle microphone off or silence all incoming audio during a call.
- **Speaking indicators** — active speakers are highlighted via voice activity detection (VAD).
- **Minimize** — collapse the call to a compact bar at the bottom of the screen.
- **Supervisor kick** — the supervisor can remove a participant from an active call.
- **Browser support** — Chrome, Edge, Brave (WebRTC required).

Voice calls use a mesh WebRTC topology with Firestore signaling — no third-party servers.

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
- Task Groups and Collaboration data are preserved on data reset and synced to the cloud.

## Data & Privacy

All data is stored in your browser's `localStorage` and optionally synced to Firebase Firestore when signed in. Nothing is sent to any other server.

**Encryption**: When enabled, all workspace data (tasks, counters, workspace names, collaboration codes) are encrypted at rest using AES-256-GCM with a key derived from your passphrase via PBKDF2 (100k iterations, SHA-256). The encrypted blob is stored under the `_enc_data` key. Preferences (theme, opacity, font, accent) remain plaintext. Encryption can be enabled, changed, or disabled from **Settings → Encryption**. If you forget your passphrase, your data cannot be recovered — there is no backdoor.

Clearing site data will erase your tasks — export to CSV first if you need a backup.

## Browser Support

| Browser | Tasks | Voice Input | Voice Calls | Cloud Sync | Collaboration |
|---|---|---|---|---|---|---|
| Chrome 90+ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edge 90+ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Brave | ✅ | ✅ | ✅ | ✅ | ✅ |
| Firefox | ✅ | ❌ | ❌ | ✅ | ✅ |
| Safari | ✅ | ⚠️ (partial) | ❌ | ✅ | ✅ |

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

Most visual settings (accent colour, font, font size, text colour, background, opacity) can be adjusted directly from the **Settings panel** without touching CSS.
