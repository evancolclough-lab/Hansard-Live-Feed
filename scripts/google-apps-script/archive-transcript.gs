/**
 * NS Hansard Live — daily transcript archive webhook.
 *
 * Not deployed via git — this file is kept here as the source of truth /
 * documentation for what to paste into Google Sheets' script editor.
 * The GitHub Actions workflow .github/workflows/archive-daily-transcript.yml
 * POSTs one JSON row to this per day, only on days the House actually sat.
 *
 * SETUP (one-time, in your own Google account):
 *   1. Open (or create) the Google Sheet you want the daily log in.
 *   2. Extensions → Apps Script. Delete the default content and paste this
 *      whole file in.
 *   3. Set a shared secret so random internet traffic can't write into your
 *      sheet (the deployed URL is technically public): in the Apps Script
 *      editor, click Project Settings (gear icon, left sidebar) → Script
 *      Properties → Add script property → key "SHARED_SECRET", value a long
 *      random string (e.g. generate one with `openssl rand -hex 32` in any
 *      terminal, or a password manager).
 *   4. Deploy → New deployment → type "Web app". Execute as: "Me". Who has
 *      access: "Anyone". Deploy, and authorize it when prompted (it's your
 *      own script acting on your own Sheet, so this is safe to approve).
 *   5. Copy the resulting URL (ends in /exec). That's the GitHub secret
 *      SHEETS_WEBHOOK_URL. The same random string from step 3 is the GitHub
 *      secret SHEETS_WEBHOOK_TOKEN. See README.md for exactly where to add
 *      both as repository secrets.
 *   6. Re-run "Deploy → Manage deployments → edit (pencil) → New version"
 *      any time you edit this script afterward — Apps Script doesn't
 *      auto-update a live deployment from editor changes alone.
 */

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var expectedToken = props.getProperty("SHARED_SECRET");

  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: "Invalid JSON body" });
  }

  if (!expectedToken) {
    return jsonResponse({ ok: false, error: "Server not configured: missing SHARED_SECRET script property" });
  }
  if (body.token !== expectedToken) {
    return jsonResponse({ ok: false, error: "Unauthorized" });
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Transcripts");
  if (!sheet) {
    sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet("Transcripts");
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Date", "Sitting", "Pages", "Word Count", "Char Count", "Transcript File", "Archived At"]);
  }

  // De-dupe on date: a re-run of the workflow for the same day (manual
  // retry, or the job somehow firing twice) updates that day's row instead
  // of appending a duplicate.
  var data = sheet.getDataRange().getValues();
  var existingRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === body.date) {
      existingRow = i + 1; // sheet rows are 1-indexed
      break;
    }
  }

  var row = [
    body.date || "",
    body.sitting || "",
    body.pages || "",
    body.wordCount || "",
    body.charCount || "",
    body.fileUrl || "",
    body.archivedAt || new Date().toISOString(),
  ];

  if (existingRow > 0) {
    sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }

  return jsonResponse({ ok: true, updated: existingRow > 0 });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
