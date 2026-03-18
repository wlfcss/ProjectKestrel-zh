# Project Kestrel — UI/UX Testing Plan

> **How to use this document:** Work through each step in order. For each bullet, mark `[x]` when the behavior is confirmed, `[!]` when something looks wrong, or `[-]` when not applicable. Steps are grouped into **CORE** (must pass every release), **GRANULAR** (important but secondary), and **MINOR** (polish/edge-case).

---

## CORE TESTS

---

### Step 0 (CORE) — First Launch & Legal Agreement

Start the application fresh (or with cleared settings so legal agreement has not yet been accepted).

- [ ] Legal/Terms of Use agreement screen is shown on first launch.
- [ ] The agreement text is legible and appropriately styled.
- [ ] "Agree" button is present and clearly labeled.
- [ ] Clicking "Agree" dismisses the agreement and proceeds to the main UI.
- [ ] After agreeing, reopening Kestrel does **not** show the agreement screen again.
- [ ] Installation telemetry is fired exactly once (visible in server logs / Cloudflare dashboard: `/api/install`).
- [ ] `settings.json` in `%LOCALAPPDATA%\ProjectKestrel\` contains `legal_agreed_version` and `installed_telemetry_sent: true`.

---

### Step 0.1 (CORE) — Tutorial (Visualizer)

Click the **?** help button (or the "Start tutorial" prompt on first visit) in the main Visualizer view.

- [ ] Tutorial overlay appears and dims the background.
- [ ] Step counter (e.g., "1 / N") and progress dots are visible.
- [ ] Each tutorial step highlights the correct UI element with a pulsing ring.
- [ ] **→ / Enter** advances to the next step.
- [ ] **← / Arrow Left** goes back to the previous step.
- [ ] **Escape** closes the tutorial.
- [ ] "Skip" link closes the tutorial from any step.
- [ ] Interactive steps (steps requiring user action) do **not** advance until the action is performed; a nudge prompt is shown.
- [ ] Final step shows a completion/done message.
- [ ] After completing the tutorial, re-opening it from the help button starts it from step 0.
- [ ] All tutorial card text is legible; no clipped or overflowing text.
- [ ] UI elements highlighted by the tutorial appear correct and functional.

---

### Step 1 (CORE) — Analyze Folders: Queue Setup

Click **Analyze Folders**. The Analyze Folders dialog opens.

- [ ] Software prompts user to select a parent/root folder via a native OS folder picker.
- [ ] Folder tree loads and displays subfolders.
- [ ] Folders that already have a `.kestrel/kestrel_database.csv` are visually distinguished (colored label: `analyzed-full`, `analyzed-partial`, or `analyzed-none`) from folders with no prior analysis.
- [ ] Folders with zero supported images are shown as greyed-out / disabled (cannot be checked).
- [ ] Folders are checkable. Checking a folder adds it to the queue preview on the right.
- [ ] The queue preview lists all pending folders.
- [ ] Photo count is shown alongside each queued folder.
- [ ] Previously-analyzed folders can still be queued for re-analysis.
- [ ] Queue shows correct counts (Pending, Done/Skipped sections).
- [ ] The "Start Analysis" button is enabled only when at least one folder is queued.
- [ ] Dialog responds smoothly — expanding large folder trees is reasonably fast.
- [ ] "Cancel" / close dismisses dialog without starting analysis.

---

### Step 1.1 (CORE) — Analysis Running & Live Preview

After clicking Start Analysis from Step 1:

- [ ] Analysis Queue panel appears (floating, collapsible) showing all queued folders.
- [ ] Progress bar for the active folder updates in real time.
- [ ] ETA is shown and decreases roughly as expected.
- [ ] Per-image progress count increments (e.g., "12 / 47").
- [ ] Overall ETA across queue is displayed.
- [ ] Average analysis speed is < 10 s/image (on supported hardware).
- [ ] Clicking the folder label in the queue panel opens the **Live Analysis Details** dialog.
- [ ] Live Details dialog shows: current filename, detection overlay thumbnail, bird crops with species label + confidence + star rating.
- [ ] High-confidence detections show green; low-confidence show amber/red styling.
- [ ] Live Details dialog can be closed with the × button and re-opened while analysis continues.
- [ ] Analysis can be **paused** — progress stops; ETA shows paused state.
- [ ] Analysis can be **resumed** after pausing — progress continues from where it left off.
- [ ] Analysis can be **cancelled** mid-folder.
- [ ] After cancellation, the folder status shows `cancelled` in the queue.
- [ ] Queue moves on to the next folder automatically after the previous one finishes.
- [ ] Analysis completion telemetry fires after each folder completes (`/api/completion` visible in logs).
- [ ] `settings.json` `kestrel_impact_total_files` increments correctly after each completed folder.

---

### Step 1.2 (CORE) — Analytics Consent Dialog

After analysis completes or is cancelled for the first time:

- [ ] Analytics consent dialog appears (shown exactly once per install).
- [ ] Dialog clearly explains what data is collected (anonymous, no filenames/paths/images).
- [ ] "Opt In" button is present and clearly labeled.
- [ ] "No Thanks" / decline option is present.
- [ ] Choosing **Opt In** sends the cached `pending_analytics` payload to `/api/analytics` (visible in logs).
- [ ] Choosing **Decline** does not send analytics; no further prompts.
- [ ] Dialog does not re-appear on subsequent launches or analyses.
- [ ] `settings.json` contains `analytics_consent_shown: true` and `analytics_opted_in` reflects choice.

---

### Step 2 (CORE) — Open Root Folder & Browse Scenes

Click **Open Folder** (or equivalent) and select a root folder containing analyzed subfolders.

- [ ] Folder tree in the sidebar correctly lists subfolders.
- [ ] Clicking a subfolder loads its scene grid.
- [ ] Scene cards appear with: thumbnail image, scene number, species name, quality score, and star rating.
- [ ] Thumbnails load for all images (lazy loading works — scrolling loads more).
- [ ] Scene count / image count in the status bar is correct.
- [ ] Loading ~1 000 scenes completes in a reasonable time (< 10 s).
- [ ] Loading ~5 000+ images does not cause obvious hangs or crashes.
- [ ] Scene cards are grouped by subfolder with collapsible group headers; header shows folder name + scene count.
- [ ] Clicking a group header collapses / expands that group.
- [ ] "Culling Assistant" button appears on each folder group header and is clickable.

---

### Step 2.1 (CORE) — Scene Detail Dialog & Open in Editor

Double-click a scene card to open the Scene Detail dialog.

- [ ] Dialog opens showing all images in the scene in a grid.
- [ ] Each image shows filename, species, quality score, and star rating.
- [ ] Thumbnail images load correctly in the dialog grid.
- [ ] Preview panel on the right shows the selected image full-size.
- [ ] Resizable divider between grid and preview panel can be dragged.
- [ ] Double-clicking an image thumbnail opens it in the configured photo editor.
- [ ] Test with **System default** — correct app opens.
- [ ] Test with **darktable** (if installed) — darktable opens with the file.
- [ ] Test with **Lightroom Classic** (if installed) — Lightroom opens with the file.
- [ ] If the configured editor is not found, system default is used as fallback (no crash).
- [ ] Dialog closes cleanly with Escape or the × button.
- [ ] Navigation between scenes in the dialog (if applicable) works.

---

### Step 3 (CORE) — Ratings, Scene Names & Saving Metadata

From the main scene grid or scene detail dialog:

- [ ] Clicking a star on a scene card sets the rating (1–5); stars render in **amber** (manual rating).
- [ ] AI-assigned star ratings render in **blue**; manually set ratings override and show amber.
- [ ] Setting rating to 0 (clicking already-selected lowest star) clears the rating back to AI default.
- [ ] Rating is immediately reflected in the scene card and in the detail dialog.
- [ ] Rating is written back to `kestrel_database.csv` (confirm by reopening the folder — rating persists).
- [ ] Scene name can be edited inline (click the name field in the scene card or dialog).
- [ ] Edited scene name persists after closing and reopening the folder.
- [ ] **Merge Scenes**: Select two or more scene cards (Ctrl+click or Shift+click), then click "Merge Scenes" in the floating action bar.
  - [ ] Merge dialog appears with a preview of the scenes being merged.
  - [ ] Confirming merge combines images into one scene; merged card appears in grid.
  - [ ] Merged scene count is correct.
  - [ ] Merge result persists after restarting Kestrel.
- [ ] **Save CSV**: Click "Save CSV" (or equivalent). Confirm file is written to disk with updated ratings/names.
- [ ] **Export CSV**: If applicable, exported CSV opens or downloads correctly and contains all expected columns.

---

### Step 4 (CORE) — Settings & Persistence

Open the **Settings** dialog.

- [ ] Settings dialog opens cleanly.
- [ ] All current settings are pre-populated with saved values.
- [ ] **Photo Editor** selector shows "System Default", "darktable", "Lightroom Classic" options.
- [ ] Changing editor and saving persists across restarts.
- [ ] **Kestrel Impact** section shows total number of images analyzed and total compute time.
  - [ ] These values match what was accumulated during earlier analysis steps.
- [ ] Any other visible settings (zoom level, folder, etc.) can be changed and persist.
- [ ] **Machine ID** is shown (or confirm it exists in `settings.json`).
- [ ] Close settings, restart Kestrel, reopen settings — all values are unchanged.
- [ ] After restart, legal agreement is **not** re-shown.
- [ ] After restart, tutorial is not re-triggered automatically.

---

### Step 5 (CORE) — Culling Assistant: Load & Auto-Categorize

From the main scene grid, click **Culling Assistant** on a folder group that has been analyzed.

- [ ] Culling Assistant opens in the same window (or new view).
- [ ] Folder name is shown in the top bar.
- [ ] All scenes load with Accept / Reject columns.
- [ ] Images are placed in Accept or Reject column according to their AI ratings (auto-categorize default).
- [ ] Top bar shows counts: total images, accepted count, rejected count, unrated count.
- [ ] Status badge updates as cards are moved.
- [ ] **Auto-Categorize panel** (⚙ button): opens a slider panel with threshold controls.
- [ ] Adjusting Accept threshold slider re-categorizes images correctly — images above threshold move to Accept.
- [ ] Adjusting Reject threshold slider re-categorizes correctly.
- [ ] Slider value labels update in real time as sliders are dragged.
- [ ] "Re-apply Auto-Categorize" button applies current thresholds while preserving manual and verified culls (toast message confirms).
- [ ] "Reset Manual Assignments" button opens a confirmation dialog; confirming resets manual culls and re-runs auto-categorization.
- [ ] Legacy folder with existing `culled` values but missing `culled_origin` preserves those values as manual after opening culling assistant and reapplying auto-categorization.
- [ ] Scene rows with all images rated show no "unrated" badge.
- [ ] Scene rows with unrated images show a yellow "unrated" badge in the scene label.

---

### Step 6 (CORE) — Culling Assistant: Manual Overrides & Preview

- [ ] Clicking a card image (without shift) selects it and shows it in the right-side Preview pane.
- [ ] Preview pane shows: filename, species + confidence, quality score, scene #, star rating.
- [ ] Preview image loads full-size (lazy, from disk).
- [ ] **Shift+click** (or drag) on a card moves it between Accept and Reject columns; card gets border color accordingly.
  - [ ] Accept cards show green left border.
  - [ ] Reject cards show red left border.
  - [ ] Moved cards gain the `moved-card` stamp overlay ("User moved" label visible).
- [ ] Cards with manual cull or manual star rating (without shift+click in this session) show a "User assigned" badge.
- [ ] Manual overrides are preserved when "Re-apply Auto-Categorize" is run (only non-manually-moved cards change).
- [ ] **Star rating** can be changed in-place from the culling card. Confirms rating updates in parent CSV.
- [ ] **Card thumbnail zoom**: bottom bar `−` and `+` buttons change card size; slider also works.
- [ ] Zoom setting persists across closing and reopening the Culling Assistant.
- [ ] **Preview pane zoom**: click-drag on the preview image to magnify; release to return.
- [ ] Preview zoom slider (in preview header) zooms smoothly.
- [ ] **Resize divider** between culling pane and preview pane can be dragged to resize both panels.
- [ ] Resize setting persists after reopening Culling Assistant.
- [ ] Culling state auto-saves periodically (debounced) — closing and reopening preserves all manual overrides.

---

### Step 7 (CORE) — Culling Assistant: Tutorial

Click the **?** help button inside the Culling Assistant.

- [ ] Culling tutorial overlay appears.
- [ ] Each step highlights the correct UI element.
- [ ] Arrow key and Escape navigation works (same as Visualizer tutorial).
- [ ] Interactive steps require user action before advancing.
- [ ] Tutorial can be dismissed at any step.
- [ ] Tutorial seen state persists (re-opening Culling Assistant does not auto-launch tutorial again).

---

### Step 8 (CORE) — Culling Assistant: Done Culling — Move Rejects

Click **Done Culling, Proceed to Review**.

- [ ] "Finish Culling" dialog opens (View 1: Options).
- [ ] Dialog shows scene summary: # accepted, # rejected, # unrated.
- [ ] **Move Rejects to _KESTREL_Rejects/** checkbox is present and checked by default.
- [ ] **Write XMP Metadata** checkbox is present.
- [ ] **Write color labels for auto-categorized images** checkbox is present and checked by default.
- [ ] **Treat current auto categories as verified** checkbox is present and unchecked by default.
- [ ] **XMP early-access note** is shown/hidden correctly when XMP checkbox is toggled.
- [ ] Both checkboxes can be independently toggled.
- [ ] With "Treat current auto categories as verified" enabled, finalized images with auto origin become `verified` and remain visible as accepted/rejected in the scene filmstrip.
- [ ] With promotion disabled, auto categories stay hidden in filmstrip/main scene view (shown as Undecided there).

### Step 8b (CORE) — XMP Label Origin Policy

- [ ] In Culling Assistant finalize flow, with auto-label checkbox ON, auto accept/reject rows receive Green/Red labels in XMP.
- [ ] In Culling Assistant finalize flow, with auto-label checkbox OFF, only manual/verified culls receive Green/Red labels.
- [ ] From timeline folder action "Write XMP Metadata", only manual/verified culls receive Green/Red labels (auto culls never do).

### Step 8c (CORE) — Folder Options Reset Actions

- [ ] Folder header includes a **Folder options...** action button.
- [ ] **Reset Verified** clears only verified cull categories in that folder.
- [ ] **Reset All** clears manual and verified cull categories in that folder.
- [ ] Reset actions do not change star ratings.
- [ ] "Execute" / proceed button is disabled when neither checkbox is checked.
- [ ] "Execute" / proceed button is enabled when at least one action is checked.
- [ ] Clicking "Execute" — with **Move Rejects** checked:
  - [ ] Progress dialog (View 3) replaces options view.
  - [ ] Progress steps animate through: "Moving files…" → done.
  - [ ] Rejected image files are physically moved to `<root>/_KESTREL_Rejects/` folder.
  - [ ] Accepted images remain in the original folder.
  - [ ] Step indicator shows ✓ when complete, or ✗ with error detail on failure.
- [ ] **Undo Move** button appears in the bottom bar after a successful move.
- [ ] Clicking **Undo Move** moves all rejected files back to their original locations.
- [ ] Undo works correctly: files are back, Undo button hides.
- [ ] "Done" button closes dialog after completion.

---

### Step 9 (CORE) — Culling Assistant: XMP Metadata Writing

In the "Finish Culling" dialog, check **Write XMP Metadata** (and optionally uncheck Move Rejects).

- [ ] Clicking "Execute" with XMP checked writes `.xmp` sidecar files alongside each image.
- [ ] XMP files are created for **accept** images (with their rating encoded in `xmp:Rating`).
- [ ] XMP files reflect the star rating correctly (1–5 stars → XMP Rating 1–5).
- [ ] Open the generated `.xmp` file in a text editor — verify it is valid XML and contains `xmp:Rating`.
- [ ] **XMP Conflict detection**: if `.xmp` files already exist, the **XMP Conflict sub-dialog** (View 2) appears before executing.
  - [ ] Conflict dialog lists the conflicting filenames.
  - [ ] "Overwrite" option overwrites existing XMP files.
  - [ ] "Skip" option leaves existing XMP files unchanged.
  - [ ] Help link in conflict dialog opens the correct URL in system browser.
- [ ] **Darktable compatibility**: import a photo with the generated XMP into darktable — star rating is visible and correct.
- [ ] **Lightroom Classic compatibility**: import a photo with the generated XMP — star rating is visible and correct.
- [ ] XMP for **reject** images: verify no garbage/incorrect rating is written for rejects (or no XMP for rejects, per design).
- [ ] Re-running "Done Culling" after XMP files already exist correctly triggers the conflict prompt.

---

### Step 10 (CORE) — Restart Persistence Check

Close Kestrel entirely, then reopen it.

- [ ] Legal agreement screen is **not** shown.
- [ ] Settings are intact (editor preference, Kestrel Impact counts).
- [ ] Open the same folder that was analyzed — scenes, ratings, and scene names are all preserved.
- [ ] If Culling was run: culling state (manual overrides) is restored when re-opening Culling Assistant for that folder.
- [ ] Overall UX is consistent with pre-restart state.

---

## GRANULAR TESTS

---

### Step 1G (GRANULAR) — Analyze Folders: Queue Manipulation

Open the Analyze Folders dialog and add 3+ folders.

- [ ] Queued items can be **reordered** by dragging the grip handle — verify items reorder correctly in the preview.
- [ ] Items dropped into new positions stay in the new order after drag is released.
- [ ] Individual queue items can be **removed** via the × remove button; queue count decreases.
- [ ] Removing an item from a pending queue while analysis is **running** on a different item works cleanly.
- [ ] **Cancel current folder** button in the queue panel stops only the active folder (not the rest of the queue).
- [ ] Queue automatically starts the next folder after cancellation.
- [ ] Adding a folder that has already been fully analyzed (all images have results) — verify behavior (skipped or re-analyzed).
- [ ] Filtering / searching the folder tree (if search field exists) narrows results correctly.
- [ ] "GPU" toggle (if present) can be changed before starting — verify it does not crash on systems without GPU.
- [ ] Queue panel can be **collapsed** and **expanded** without disrupting analysis.

---

### Step 2G (GRANULAR) — Scene Grid: Filtering & Sorting

Load a folder with many scenes (50+).

- [ ] **Species filter** dropdown: selecting a species filters grid to matching scenes only; count updates.
- [ ] Selecting "All species" restores full grid.
- [ ] **Rating filter**: filtering by rating shows only scenes at or above the threshold.
- [ ] **Sort order**: changing sort (by quality, by rating, by scene #, etc.) reorders cards visibly.
- [ ] **Search** field (if present): typing filters scenes by filename or species name.
- [ ] Filters stack correctly (e.g., species + rating filter simultaneously).
- [ ] Clearing all filters restores the full list.
- [ ] Filter/sort state does not persist unexpectedly across folder switches (or does persist, per design).
- [ ] **Multi-select**: Ctrl+click selects multiple scene cards simultaneously; selection ring is visible.
- [ ] Shift+click selects a range of scenes.
- [ ] Pressing Escape clears multi-selection.
- [ ] Floating multi-select action bar appears when 2+ cards are selected; hides when deselected.
- [ ] Multi-select action bar "Merge" and other actions work correctly.

---

### Step 3G (GRANULAR) — Culling Assistant Edge Cases

- [ ] Opening Culling Assistant on a folder with **zero unrated** images shows empty unrated sections cleanly.
- [ ] Opening on a folder with **a mix of RAW and JPEG** images: both file types appear and can be culled.
- [ ] Scenes with only 1 image display correctly (no empty accept/reject column).
- [ ] Very long filenames truncate gracefully without breaking layout.
- [ ] Scrolling through a large scene list (100+ scenes) is smooth; no janky scroll.
- [ ] Lazy-loaded thumbnails in the culling pane load correctly as you scroll.
- [ ] After reloading culling state from disk, manually-moved cards retain their `moved-card` appearance.
- [ ] Star rating changes in Culling Assistant are reflected immediately when going back to the main Visualizer view.
- [ ] If all images are accepted, clicking "Done Culling" and executing "Move Rejects" moves 0 files; completion still shown.

---

### Step 4G (GRANULAR) — Sample Sets

From the Welcome panel or Analyze Folders:

- [ ] "Load Sample Set" or equivalent option is visible.
- [ ] Sample set "Backyard Birds" loads and displays scenes with bird images.
- [ ] Sample set "Forest Trail" loads and displays correctly.
- [ ] Images in sample sets are pre-analyzed — species names, quality scores, and ratings are shown.
- [ ] Double-clicking a sample image opens it in the photo editor without error.

---

### Step 5G (GRANULAR) — Folder Tree Behavior

In the sidebar folder tree:

- [ ] Folders expand/collapse via the arrow chevron.
- [ ] The active folder is highlighted distinctly.
- [ ] Folders without analyzed images are styled differently (greyed-out or `no-kestrel` class).
- [ ] Folders with full analysis data show the `analyzed-full` bright label.
- [ ] Folders with partial analysis show `analyzed-partial` styling.
- [ ] `analyzed-none` folders (has `.kestrel` dir but no results) show correct styling.
- [ ] Tree scan is truncated cleanly at 2000 nodes — a notice or truncation message is shown if hit.
- [ ] Hidden/system folders (e.g., `$RECYCLE.BIN`, `__pycache__`) do not appear in the tree.

---

### Step 6G (GRANULAR) — Info / About Dialog

Click the info/version badge or an "About" option.

- [ ] Info dialog shows current version string matching `VERSION.txt`.
- [ ] Any links in the dialog (e.g., projectkestrel.org) open in the system browser.
- [ ] Machine ID is visible (if shown) and is a valid UUID4 string.

---

### Step 7G (GRANULAR) — Feedback / Bug Report

Click the feedback button (speech bubble icon or equivalent).

- [ ] Feedback dialog opens with report type selector: Bug, Suggestion, I liked something, General.
- [ ] Description text area accepts free text input.
- [ ] Optional contact email field is present.
- [ ] "Include recent logs" checkbox is present.
- [ ] "Attach screenshot" option (if present) works.
- [ ] Clicking "Submit" with a description sends feedback to `/api/feedback` (confirm in server logs).
- [ ] Toast or confirmation message appears after submission.
- [ ] Submitting with an empty description shows a validation hint rather than crashing.
- [ ] Closing the dialog without submitting makes no network call.

---

## MINOR TESTS

---

### Step M1 (MINOR) — Link & Button Smoke Test

Visit every dialog and panel in the app:

- [ ] **Legal Agreement** — if a ToS / Privacy Policy link is present, it opens the correct URL.
- [ ] **XMP Help Link** (in Finish Culling dialog / conflict dialog) → opens `https://projectkestrel.org/help/metadata-help` in the system browser.
- [ ] **Welcome Panel** (first-load) — all three "quick-start" cards are visible and their action buttons are functional.
- [ ] Welcome panel links (e.g., "Learn more", project website) open correct URLs.
- [ ] Settings dialog external links (if any) open correctly.
- [ ] Feedback dialog "learn more" or privacy links open correctly.
- [ ] All `disabled` buttons are visually faded and cannot be clicked.
- [ ] All `primary` (green) buttons have correct hover state.
- [ ] All `danger` (red) buttons have correct hover state.

---

### Step M2 (MINOR) — Toast & Notification Behavior

- [ ] Toasts appear in the correct position (bottom-right or top of view area).
- [ ] Toasts auto-dismiss after ~3 s.
- [ ] Multiple rapid actions do not stack into unreadable toast pileups.
- [ ] "Auto-categorize re-applied" toast appears when "Re-apply" is clicked in Culling Assistant.
- [ ] Any error toast has a visually distinct color or icon.

---

### Step M3 (MINOR) — Responsive Layout & Zoom

- [ ] Resizing the main window to a narrow width does not break layout or hide essential controls.
- [ ] The main scene grid zoom slider (bottom bar) enlarges/shrinks cards smoothly.
- [ ] The zoom level persists between sessions (check `settings.json`).
- [ ] Very small window size (e.g., 800×600) — main content areas add scroll rather than overflow invisibly.
- [ ] The culling pane / preview pane resize divider does not allow either panel to collapse to 0 width.

---

### Step M4 (MINOR) — Status Bar

- [ ] Bottom status bar shows current loaded folder path or a meaningful status string.
- [ ] During analysis, status bar reflects activity (progress, current file, etc.).
- [ ] After analysis completes, status bar returns to a ready/idle state.
- [ ] Version badge in the status bar shows the correct version.

---

### Step M5 (MINOR) — Keyboard Navigation

- [ ] In the Visualizer tutorial: Right Arrow / Enter advances; Left Arrow goes back; Escape closes.
- [ ] In the Culling tutorial: same keyboard behavior.
- [ ] Escape clears multi-scene selection when no dialog is open.
- [ ] Tab key cycles through interactive elements in dialogs in a logical order.
- [ ] Enter activates the focused button in dialogs.

---

### Step M6 (MINOR) — Error & Edge Cases

- [ ] Opening a folder that has **no `.kestrel` subfolder** at all: appropriate empty-state message is shown.
- [ ] Opening a folder where `kestrel_database.csv` exists but is **empty or malformed**: no crash; error toast displayed.
- [ ] Attempting to start analysis when **no GPU is available** and GPU mode is requested: falls back gracefully to CPU.
- [ ] Deleting an image file from disk while Kestrel is open: reloading the folder handles the missing file gracefully.
- [ ] Analysis of a folder with **0 supported images**: queue item immediately marked done (or error); no infinite spin.
- [ ] Cancelling the folder picker dialog (without selecting a folder) does not cause errors or state corruption.
- [ ] Very long species names do not overflow card containers.
- [ ] Score values of `0.000`, `1.000`, and negative values display formatted as `—` or `0.000` as appropriate.

---

### Step M7 (MINOR) — Telemetry Endpoint Coverage

Using the application normally (with a proxy/log if needed), confirm the following backend endpoints fire:

- [ ] `/api/install` — fires once on first legal agreement (never repeated).
- [ ] `/api/completion` — fires after each analyzed folder (even if 0 new files).
- [ ] `/api/analytics` — fires after opt-in **and** when a folder completes (or pending analytics are flushed).
- [ ] `/api/feedback` — fires when a feedback form is submitted.
- [ ] `/api/crash` — fires if an unhandled exception occurs (can be manually triggered in dev builds).
- [ ] No telemetry endpoint receives PII: no file paths, no image data, no real folder names (only hashed folder names).

---

*Last updated: 2026-03-04*
