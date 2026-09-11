# Gīkũyũ Family Tree - Setup Guide

An interactive family tree for the Wang'ang'a family. Google Sheets acts as the
database, Google Apps Script is the backend API, and a D3.js single-page app is
hosted free on GitHub Pages.

## Architecture

```
index.html + styles.css + app.js   ->  GitHub Pages (static frontend)
Code.gs                            ->  Google Apps Script (backend JSON API)
Google Sheet                       ->  database (Persons + Relationships tabs)
Google Drive folder                ->  photo storage (auto-created, public)
```

## Step 1: Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet
2. Name it **"Family Tree Database"**
3. The script will auto-create the `Persons` and `Relationships` sheets on first run

## Step 2: Set Up Google Apps Script (Backend)

1. In your spreadsheet, go to **Extensions > Apps Script**
2. Delete any default code in `Code.gs`
3. Copy the entire contents of `Code.gs` from this project into the editor

### Configure the two Script Properties (required)

Both secrets live in **Script Properties**, never in source code:

1. In the Apps Script editor, open **Project Settings** (gear icon)
2. Scroll to **Script properties** > click **Add property** twice:

   | Key | Value |
   |-----|-------|
   | `SPREADSHEET_ID` | The ID from your spreadsheet URL (see below) |
   | `SUPERADMIN_TOKEN` | Any secret of 8+ characters |

3. Click **Save properties**

**Where to find your Spreadsheet ID:** open your Google Sheet and look at the
URL:
```
https://docs.google.com/spreadsheets/d/1GQCXKJ7hUzDoZtHk8pYuJaaS6D2M3XabOZ44oDst1Bw/edit
                     └────────────────────────────────────────────────────┘
                       THIS part between /d/ and /edit is the ID
```

> **Redaction note:** the spreadsheet ID is *not* in `Code.gs` anymore. The
> script throws a clear "SPREADSHEET_ID not configured" error until you add it.
>
> For the admin token, `Code.gs` currently carries a temporary fallback of
> `Kenya254` so the app works immediately. **Once your `SUPERADMIN_TOKEN`
> property is set, the property value is used and you can delete the
> `DEFAULT_SUPERADMIN_TOKEN` line from `Code.gs`.**

### Finish setup

4. Click **Save** (Ctrl+S)
5. Click **Run** > select `init` > click **Run** to initialize the sheets
6. When prompted, click **Review Permissions** and authorize the script

### Changing the admin token later (no redeploy needed)

- **From the Apps Script console:** Project Settings > Script Properties >
  edit the `SUPERADMIN_TOKEN` value > Save.
- **From the app:** unlock Admin with the current code, then call the
  `setAdminToken` POST action with `{ admin_token: "<current>", new_token: "<new>" }`.
  The config then updates automatically.

## Step 3: Deploy as Web App (API)

1. In the Apps Script editor, click **Deploy > New deployment**
2. Select type: **Web app**
3. Description: "Family Tree API"
4. Execute as: **Me**
5. Who has access: **Anyone** (or "Anyone with Google account" for restricted access)
6. Click **Deploy**
7. **Copy the Web App URL** (looks like `https://script.google.com/macros/s/AKfyc.../exec`)

## Step 4: Point the Frontend at the API

1. Open `app.js` and find:
   `const API_URL = 'https://script.google.com/macros/s/.../exec';`
2. Replace it with your deployed URL from Step 3
3. Also update `scripts/config.js` (used by the seed scripts)

## Step 5: Host the Frontend on GitHub Pages

GitHub Pages allows one site per user account AND unlimited project sites.
Since you already have a site running (e.g. `barber4all.co.ke`), this app gets
its own repository and deploys to `https://<username>.github.io/<repo>/`.

1. Create a new GitHub repository (e.g. `family-tree`)
2. Push `index.html`, `styles.css`, `app.js`, and this guide:
   ```
   git init
   git add .
   git commit -m "Initial family tree app"
   git branch -M main
   git remote add origin https://github.com/<username>/family-tree.git
   git push -u origin main
   ```
3. Go to **Settings > Pages**
4. Set source to **Deploy from a branch** > **main** > **/(root)**
5. Your app is live at `https://<username>.github.io/family-tree/`

### Alternative: Netlify
Drag and drop the folder containing `index.html` to [app.netlify.com/drop](https://app.netlify.com/drop).

### Local Testing
Run a local server: `npx serve .` or `python -m http.server 8000`, then open
`http://localhost:8000`.

## Step 6: Onboarding Link

To let relatives join the tree, share your GitHub Pages URL with the
`?onboard=1` parameter:
```
https://<username>.github.io/family-tree/?onboard=1
```
This forces the onboarding modal on load, letting relatives search for their
name and merge or create a profile.

## View-Only Link (Read-Only Sharing)

To share a **read-only** version with family members who should only view
(not edit), use the `?view=1` or `?readonly=1` parameter:
```
https://<username>.github.io/family-tree/?view=1
```

This mode:
- Hides the **+ Add Person** button
- Hides the **Admin** button
- Disables right-click / radial menu on nodes
- Hides **Edit**, **Delete**, and **Research** tabs in the info panel
- Shows a "👁 View Only" badge
- Still allows zoom/pan and clicking nodes to see LifeStory

## Admin Guide

- The admin token lives in **Script Properties** (key `SUPERADMIN_TOKEN`), not
  in source code. Set or change it any time without redeploying.
- Unlock it in the app via the **Admin** button. It grants edit/delete power
  over records created by anyone.

## Seeding Sample Data

The sample family (15 people) can be created with the Node scripts:

```
npm install          # not required, but sets up tooling
npm run seed:persons
npm run seed:relationships
npm run seed:spouses
```

Or PowerShell (Windows): `npm run seed:persons:win`

Run `npm run dedupe` afterwards if any relationships were duplicated.

**Note:** The seed scripts POST to your live spreadsheet. Run them once on a
spreadsheet you intend to use for real data, or point `scripts/config.js` at a
test deployment.

## Spreadsheet Structure

### Table A: Persons
| Column | Type | Description |
|--------|------|-------------|
| person_id | String | Unique UUID |
| gikuyu_name | String | Main tribal name |
| fathers_name | String | Father's name (lineage linker) |
| other_names | String | Christian/English names |
| gender | String | Male or Female |
| is_living | Boolean | TRUE or FALSE |
| birth_year | Integer | YYYY format |
| photo_url | String | Drive thumbnail URL |
| death_year | Integer | YYYY format |
| created_by | String | Device-scoped owner token |
| place_of_birth | String | Birthplace (geographic location) |
| place_of_living | String | Current residence / place of living |
| place_of_death | String | Place of death (deceased only) |
| birth_qualifier | String | exact, before, during, after (year precision) |
| birth_month | Integer | Optional birth month 1-12 |
| birth_day | Integer | Optional birth day 1-31 |
| death_qualifier | String | exact, before, during, after (year precision) |
| death_month | Integer | Optional death month 1-12 |
| death_day | Integer | Optional death day 1-31 |

### Table B: Relationships
| Column | Type | Description |
|--------|------|-------------|
| relationship_id | String | Unique UUID |
| parent_id | String | Maps to person_id |
| child_id | String | Maps to person_id |
| rel_type | String | Father-Child, Mother-Child, or Spouse |
| spouse_link_id | String | Reserved for spouse pairing |
| created_by | String | Device-scoped owner token |

## API Endpoints

### GET Actions
- `?action=getAll` - Returns all persons and relationships
- `?action=getPersons` - Returns all persons
- `?action=getRelationships` - Returns all relationships
- `?action=search&query=...` - Search persons by name
- `?action=getPerson&person_id=...` - Get a single person

### POST Actions (JSON body)
- `createPerson` - Add a new person
- `updatePerson` - Update person fields (owner/admin only)
- `deletePerson` - Remove person and their relationships (owner/admin only)
- `createRelationship` - Add a parent-child or spouse link
- `deleteRelationship` - Remove a relationship (owner/admin only)
- `mergePerson` - Update existing person (onboarding merge, fill-blank-fields only)
- `search` - Search with POST body
- `ping` - Validate an admin token
- `setAdminToken` - Rotate the admin token (current admin required)

All create/update actions accept `user_token` for ownership tracking and
`admin_token` for admin overrides.

## Troubleshooting

**"Script not authorized" error:**
Run the script once manually from the Apps Script editor to trigger the OAuth consent screen.

**CORS errors:**
Google Apps Script web apps handle CORS automatically when deployed correctly.
Ensure the deployment is set to "Anyone" access.

**Data not loading:**
- Check that `API_URL` in `app.js` and `scripts/config.js` matches your deployed web app URL
- Ensure the Google Sheet has the `Persons` and `Relationships` sheets (they auto-create)
- Check the Apps Script execution log for errors (**Executions** in the editor)

**"Unauthorized" when editing/deleting:**
Records are only editable by the device that created them (device token) unless
you supply the admin token via the Admin button.