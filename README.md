# Gmail Transaction Alerts → Google Sheets

A small Google Apps Script that reads supported bank transaction-alert emails from Gmail and appends one row per transaction to a Google Sheet.

It deliberately does one thing: **detect a supported transaction-alert email, extract its fields, and append a row.** No bank credentials, no third-party aggregator, no server, no categorization built in. Each user runs a private copy of the spreadsheet and script; nothing is shared between installs.

## Supported alerts

| Institution | Sender | Handling |
|---|---|---|
| USAA | `USAA.Customer.Service@mailcenter.usaa.com` | Card purchase authorizations, bank-account debit alerts, and bank-account deposit alerts imported |
| Chase | `no.reply.alerts@chase.com` | Credit and debit merchant purchases, outbound transfers, and Zelle money received imported; scheduled card payments and daily account summaries ignored |
| Venmo | `venmo@venmo.com` | P2P payments you sent and payments you received imported; other Venmo mail goes to Needs Review |

Anything else from a trusted sender is routed to an **Import Issues** sheet and labeled **Needs Review** rather than silently dropped. Mail from any other sender is rejected outright.

## Install

1. Open your spreadsheet → **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with [`gmail-transaction-alerts-Code.gs`](gmail-transaction-alerts-Code.gs).
3. Save, reload the spreadsheet tab.
4. **Transaction Alerts → Setup / Initialize** (authorize when prompted).
5. **Transaction Alerts → Import Now**, then **Automatic Import → Every 5 minutes**.

On the **Setup** sheet, `Import USAA`, `Import Chase`, and `Import Venmo` default to `TRUE`. Set any to `FALSE` to pause that institution without labeling its mail; turning it back on resumes import within the usual 30-day search window.

Apps Script has no Gmail-arrival trigger, so this polls on a time-driven trigger (1/5/10/15/30/60 minutes). Google does not guarantee exact execution times.

## Adding your own columns

You can add category or formula columns anywhere on the Transactions sheet. The script resolves its own columns **by header text in row 1**, so keep these thirteen headers intact:
