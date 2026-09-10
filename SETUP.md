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
4. **Set your spreadsheet ID** (Script Editor > Project Settings or `Code.gs` line 10)
5. **Set your admin token** via the Apps Script console:
   - **Project Settings > Script Properties > Add**:
     - Key: `SUPERADMIN_TOKEN`
     - Value: a secret code at least 8 chars long (e.g. `kQ8#zW?e2!vR9@dX`)
6. Click **Save** (Ctrl+S)
7. Click **Run** > select `init` > click **Run** to initialize the sheets
8. When prompted, click **Review Permissions** and authorize the script

To change the admin token later, edit the Script Property, or use the app's
Admin button to unlock, then call the `setAdminToken` action.

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