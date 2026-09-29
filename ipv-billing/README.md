# FACES Adult IPV Billing

Builds the monthly Santa Clara County Probation **Client List** billing (Adult IPV, contract 4300022130) from the class attendance trackers. It also checks the list for errors before it is submitted.

It runs entirely in the browser. No client data is uploaded anywhere, and no server or install is needed.

## Open it

Double-click `index.html` (Chrome or Edge recommended). Keep the `vendor/` folder next to it. The libraries are bundled, so it also works offline.

## Monthly workflow

1. **Billing month.** This defaults to last month.
2. **County Client List.** Drop the FY27 workbook (for example `August_2026_FACES_IPV_Client_List_Template_FY27.xlsx`). The month tab (`Aug2026`) is picked automatically.
3. **Attendance trackers.** Drop each class tracker as a PDF, Excel or CSV file. You can also fetch it from its Google Sheets link (see below). The group (G1A, G1B, G2B, G1D…) is read from the file name, and you can change it.
4. **Findings.** Clear anything marked Critical or Warning.
5. **Name matching.** Confirm any tracker name marked *Review* or *Unmatched*. Confirmed matches are remembered for next month.
6. **Export.**
   - **Client List (.xlsx)** is your original workbook with the billing columns filled in. Only those cells change.
   - **Audit (.xlsx)** holds the summary, per-client billing, every attendance date, the findings and the cells written. Keep it with the submission.
   - **Narrative figures** are the counts for the monthly narrative and PAR.

## Billing rules

| Tracker mark | Counts as |
|---|---|
| `A` Attended | 1 group session |
| `MA` Make-up + attended | 1 group session **and** 1 make-up |
| `M` Make-up only | 1 make-up |
| `N` Not attended | absence (not billed) |
| `-` | not enrolled that date (ignored) |

| County column | Value |
|---|---|
| U Duration of Intake Appointment | 1.0 when the Program Entry Date falls in the billing month (can be ticked or unticked per client) |
| V Number of Sessions | A + MA |
| W Duration of Sessions | V × 1.5 |
| AA Number of Make-up Sessions | M + MA |
| AB Hours for Make-up Sessions | AA × 1.5 |
| AC Make-up Session Type | Individual (default; can be changed per client) |

Hours per session, intake hours and optional billing rates can be changed under **Export → Rates and hours**.

## Checks performed

- **Critical:** attendance billed after the Program Exit Date; tracker rows with attendance that match no one on the County list; a tracker from a different month.
- **Warning:** attendance before the Service Start Date; an active client with no attendance; a completed or discharged client with no exit date; an exit date on a client still marked active; hours that don't equal sessions × 1.5; the same client billed in two groups on one date; a client whose other group's tracker is not loaded.
- **Info:** absences, TPR-section listings, a client attending outside their roster group, and unrecognized marks such as `NH`.

## Export modes

- **Fill blank cells only** (default) keeps anything staff already entered.
- **Replace with tracker totals** overwrites the billing cells for clients in the loaded groups.

In both modes, a client who also attends a group whose tracker isn't loaded is skipped, so a partial count is never written.

The Client List export edits the worksheet XML cell by cell. Dropdown lists, conditional formatting, hidden tabs and every other month's tab stay byte-for-byte identical. Excel recalculates when the file is opened.

## Google Sheets links

Under **Sources → Google Sheets class links**, save each class's link once (stored on this computer only). Use **Tab** for the monthly tab name; `{Month} - {Year}` becomes `August - 2026`.

Direct fetch only works when a sheet is shared as *Anyone with the link can view*. Because trackers contain client names, the recommended route is to keep sheets restricted. Instead, use **File → Download → Microsoft Excel (.xlsx)** and drop the file in.

## Development

- `billing-core.js` holds every billing rule as pure functions, shared by the app and the tests.
- `app.js` handles the browser UI, file reading and exports.
- Run the tests with `node --test ipv-billing/test/*.test.js`. The test data is fictional. Never commit real client files to this repository.
- Vendored libraries: ExcelJS 4.4.0, pdf.js 3.11.174, fflate 0.8.2 (licenses in `vendor/`).
