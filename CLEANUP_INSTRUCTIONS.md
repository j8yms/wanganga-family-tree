# Fix Existing Tree Data - Instructions

## Quick Start

1. **Open your Google Apps Script project:**
   - Go to your Google Sheet → Extensions → Apps Script
   - Or go directly to `script.google.com` and open your project

2. **Copy the cleanup code:**
   - Open `fix-existing-data.gs` from this repo
   - Copy ALL the code and paste it at the bottom of your `Code.gs` file
   - Save (Ctrl+S)

3. **Run the preview first (safe, no changes):**
   - In the Apps Script toolbar, select `previewFixes` from the function dropdown
   - Click **Run** (▶️)
   - Check **Execution log** (View → Execution log) to see what would be added

4. **If preview looks good, run the actual fix:**
   - Select `runAllFixes` from the dropdown
   - Click **Run** (▶️)
   - Check Execution log for results

## What Each Function Does

| Function | Purpose |
|----------|---------|
| `previewFixes()` | **Safe dry-run** - shows what relationships would be added without making changes |
| `runAllFixes()` | **Run all fixes** - removes duplicates, fixes orphaned spouses, links children to all parents |
| `removeDuplicateRelationships()` | Removes exact duplicate relationship rows |
| `fixOrphanedSpouses()` | Fixes spouse links that don't point to the primary anchor |
| `fixExistingRelationships()` | **Main fix** - ensures every child is linked to father + ALL wives |

## Expected Results

After running `runAllFixes()`:
- ✅ Every child linked to their father
- ✅ Every child linked to their biological mother
- ✅ Every child ALSO linked to all step-mothers (father's other wives)
- ✅ No duplicate relationships
- ✅ All spouse clusters properly anchored
- ✅ Tree renders correctly with polygamous families

## Troubleshooting

**"SPREADSHEET_ID not configured"**
- Go to Project Settings (gear icon) → Script Properties
- Add `SPREADSHEET_ID` with your Google Sheet ID

**"SUPERADMIN_TOKEN not configured"**
- Add `SUPERADMIN_TOKEN` in Script Properties (any 8+ char string)

**Permission errors**
- The script needs access to your Google Sheet and Drive
- Click "Review permissions" when prompted and allow access

## Verify the Fix

After running, go to your GitHub Pages site and:
1. Refresh the page
2. Check that children appear under ALL mothers in the father's cluster
3. Verify no duplicate nodes or ghost icons
4. Test adding a new child - it should auto-link to all parents

## Rollback (if needed)

If something goes wrong, you can restore from Google Sheets version history:
- Google Sheet → File → Version history → See version history
- Restore to a version before the cleanup ran