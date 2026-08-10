/**
 * Gmail Transaction Alerts -> Google Sheets
 * Google Apps Script. Paste this whole file into Code.gs.
 *
 * INSTALL
 *   1. Open your budget spreadsheet, then Extensions > Apps Script.
 *   2. Select everything in Code.gs and replace it with this entire file.
 *   3. Save, then reload the spreadsheet tab.
 *   4. Menu: Transaction Alerts > Setup / Initialize (authorize when prompted).
 *   5. Menu: Transaction Alerts > Import Now.
 *   6. Menu: Transaction Alerts > Automatic Import > Every 5 minutes.
 *
 * ADDING YOUR OWN COLUMNS
 *   You can add category/formula columns anywhere on the Transactions sheet.
 *   The script finds its own columns by the header text in row 1, so do not
 *   rename or delete these thirteen headers:
 *     Imported At, Transaction Date, Institution, Card Type, Last 4,
 *     Cardholder, Merchant, Amount, Gmail Message ID, Email Received At,
 *     Event Type, Parser Version, Fingerprint
 *   (The last five are hidden audit columns. If a header is missing, the
 *   import stops with an error naming it instead of writing to the wrong place.)
 *
 * NOTES
 *   USAA bank-account debit alerts have no merchant, so Merchant is the fixed
 *   label "USAA Bank Debit"; Card Type is "bank debit" and Event Type is
 *   account_debit. Account deposit alerts are not supported yet and go to
 *   Needs Review.
 *   Chase and Venmo alerts do not include a cardholder name, so that cell is
 *   blank on those rows. Chase outbound transfers use Card Type "transfer"
 *   and Event Type transfer_out; Merchant is the recipient. Venmo amounts are
 *   always positive; Event Type is venmo_payment (you paid) or
 *   venmo_payment_received (someone paid you). This is an authorization-alert
 *   log, not a posted bank ledger: tips, refunds, and final posted amounts
 *   can differ.
 */

// ===== appsscript/Config.gs =====
var APP_CONFIG = Object.freeze({
  parserVersion: '1.6.2',
  // USAA now sends from mailcenter; the older omem subdomain is retired and
  // was removed deliberately. Entries are matched as exact addresses -- adding
  // or correcting one is the supported fix for a rejected sender; loosening the
  // comparison is not. The address is also referenced from README.md and three
  // test files, so grep for it before changing it here.
  trustedSenders: Object.freeze({
    'usaa.customer.service@mailcenter.usaa.com': 'USAA',
    'no.reply.alerts@chase.com': 'Chase',
    'venmo@venmo.com': 'Venmo'
  }),
  // Setup sheet rows that gate which institutions are searched. Seeded as TRUE
  // once; initialize never overwrites an existing Value.
  importToggles: Object.freeze({
    'Import USAA': 'USAA',
    'Import Chase': 'Chase',
    'Import Venmo': 'Venmo'
  }),
  supportedIntervals: Object.freeze([1, 5, 10, 15, 30, 60]),
  labels: Object.freeze({
    imported: 'Bank Transactions/Imported',
    ignored: 'Bank Transactions/Ignored',
    review: 'Bank Transactions/Needs Review'
  })
});

// ===== appsscript/Text.gs =====
function decodeHtmlEntities_(value) {
  var entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, function (_, key) {
    var lower = key.toLowerCase();
    if (lower.charAt(0) === '#') {
      var hex = lower.charAt(1) === 'x';
      return String.fromCharCode(parseInt(lower.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return entities[lower] || _;
  });
}

function htmlToText_(html) {
  return decodeHtmlEntities_(String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/\s*(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function normalizeText_(value) {
  return String(value || '').replace(/\r/g, '\n').replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeSender_(value) {
  var text = String(value || '').trim().toLowerCase();
  var match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim();
}

function parseAmount_(value) { return Number(String(value).replace(/[$,\s]/g, '')); }

function parseUsDate_(value) {
  var m = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  var year = Number(m[3]); if (year < 100) year += 2000;
  return String(year) + '-' + String(Number(m[1])).padStart(2, '0') + '-' + String(Number(m[2])).padStart(2, '0');
}

var MONTH_NAMES_ = Object.freeze({ jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 });

// "Aug 4, 2026" / "August 4, 2026" / "Sept. 4, 2026" -> "2026-08-04"
function parseMonthNameDate_(value) {
  var m = String(value).match(/^\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})\s*$/);
  if (!m) return null;
  var month = MONTH_NAMES_[m[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  var day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  return m[3] + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

// ===== appsscript/Parsers.gs =====
// Resolves a From header to an institution, or null if it is not on the
// allowlist. Comparison is case-insensitive on BOTH sides: email addresses are
// case-insensitive in practice, and a config edited with the capitalized
// spelling used in the docs must still match. This is an exact-address check --
// it is not a substring or domain match, and must never become one.
function trustedInstitution_(sender) {
  var normalized = normalizeSender_(sender);
  var senders = APP_CONFIG.trustedSenders;
  var keys = Object.keys(senders);
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i]).trim().toLowerCase() === normalized) return senders[keys[i]];
  }
  return null;
}

function parseAlert(sender, subject, htmlBody, plainBody) {
  var institution = trustedInstitution_(sender);
  if (!institution) return { outcome: 'needs_review', reason: 'Untrusted sender' };
  // Normalize plain first. Venmo (and some other senders) ship an empty or
  // whitespace-only text/plain part; `plainBody || html` would treat "\n" as
  // present and skip the HTML that actually has the fields.
  var text = normalizeText_(plainBody);
  var htmlText = normalizeText_(htmlToText_(htmlBody));
  if (!text) text = htmlText;
  // Venmo's useful content lives in HTML; synthesized plain from Gmail can be
  // non-empty but flattened so Date is not on its own line. Prefer HTML.
  if (institution === 'Venmo' && htmlText) text = htmlText;
  if (institution === 'USAA') return parseUsaa_(text);
  if (institution === 'Chase') return parseChase_(subject, text);
  if (institution === 'Venmo') return parseVenmo_(subject, text);
  return { outcome: 'needs_review', institution: institution, reason: 'Unsupported institution' };
}

// USAA sends two alert shapes. Card purchases name a merchant; bank-account
// debits do not. Routing is on the account-debit wording rather than the
// subject because only the body is available here, and anything unrecognized
// still falls through to the purchase parser and on to review.
function parseUsaa_(text) {
  if (/came out of your account ending in/i.test(text)) return parseUsaaAccountDebit_(text);
  return parseUsaaPurchase_(text);
}

// The security-zone header carries the account holder's name between the
// "USAA SECURITY ZONE" banner and the "USAA # ending in" line. In HTML the
// first and last name are separated by <br />, so they arrive on separate
// lines; the plain part puts them on one. Best effort by design: a reshaped
// header yields an empty Cardholder rather than failing an otherwise complete
// alert. The name is omitted when absent, never guessed.
function usaaSecurityZoneName_(text) {
  var m = String(text).match(/USAA SECURITY ZONE\s*([\s\S]*?)\s*USAA\s*#\s*ending\s+in\s*:?\s*\d{4}/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

// Bank-account debit alert, subject "Debit Alert for Your USAA Bank Account".
// Body reads "$88.45 came out of your account ending in 7788." with To: and
// Date: as two-cell table rows, so label and value land on consecutive lines
// after htmlToText_ -- the Date regex bridges that with \s*.
//
// There is no merchant on this alert type. The only descriptive field is the
// To: destination, which is the constant "USAA DEBIT", so Merchant is a fixed
// label rather than a parsed value. The To: row is deliberately not required:
// its value is unused, so requiring it would add a failure mode without adding
// data. Amount stays positive and direction lives in Event Type, matching
// Chase transfers and Venmo receipts. Card Type is "bank debit", not "debit",
// because Chase debit-card purchases already use "debit".
function parseUsaaAccountDebit_(text) {
  var debit = text.match(/(\$[\d,]+(?:\.\d{2})?)\s+came out of your account ending in\s+(\d{4})/i);
  var date = text.match(/Date\s*:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (!debit || !date) return { outcome: 'needs_review', institution: 'USAA', reason: 'Unsupported or incomplete USAA account alert' };
  var parsedDate = parseUsDate_(date[1]);
  var amount = parseAmount_(debit[1]);
  if (!parsedDate || !Number.isFinite(amount)) return { outcome: 'needs_review', institution: 'USAA', reason: 'Invalid USAA date or amount' };
  return { outcome: 'imported', transaction: {
    transactionDate: parsedDate, institution: 'USAA', cardType: 'bank debit',
    last4: debit[2], cardholder: usaaSecurityZoneName_(text), merchant: 'USAA Bank Debit',
    amount: amount, eventType: 'account_debit'
  }};
}

function parseUsaaPurchase_(text) {
  var charge = text.match(/Your\s+(.+?)\s+\.{3}\s*(\d{4})\s+was charged\s+(\$[\d,]+(?:\.\d{2})?)\s+at\s+(.+?)(?=\n\s*Date\s*:)/i);
  var date = text.match(/Date\s*:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  var holder = text.match(/Cardholder\s*name\s*:\s*([^\n]+)/i);
  if (!charge || !date || !holder) return { outcome: 'needs_review', reason: 'Unsupported or incomplete USAA alert' };
  var parsedDate = parseUsDate_(date[1]);
  var amount = parseAmount_(charge[3]);
  if (!parsedDate || !Number.isFinite(amount)) return { outcome: 'needs_review', reason: 'Invalid USAA date or amount' };
  return { outcome: 'imported', transaction: {
    transactionDate: parsedDate, institution: 'USAA', cardType: charge[1].trim().toLowerCase(),
    last4: charge[2], cardholder: holder[1].trim(), merchant: charge[4].trim(), amount: amount,
    eventType: 'purchase_authorization'
  }};
}

function parseChase_(subject, text) {
  var combined = normalizeText_((subject || '') + '\n' + text);
  if (/Payment scheduled/i.test(combined) && /credit card payment/i.test(combined)) {
    return { outcome: 'ignored', institution: 'Chase', eventType: 'card_payment_scheduled', reason: 'Scheduled card payment is not a merchant purchase' };
  }
  // Outbound transfers: "You sent $X to RECIPIENT" / Transfer alert badge.
  // Distinct from purchases (Merchant|Description) and card payments.
  if (/You sent\s+\$[\d,]+(?:\.\d{2})?/i.test(combined) || /(?:^|\n)\s*Transfer alert\b/i.test(combined)) {
    return parseChaseTransferOut_(subject, text);
  }
  return parseChasePurchase_(subject, text);
}

// Chase outbound transfer to another bank/account. Field labels differ from
// purchases: Account ending in / Sent on / Recipient / Amount. After
// htmlToText_, label and value often land on consecutive lines, so field
// regexes use \s*. Subject and body headline are fallbacks only. No
// cardholder; Card Type is "transfer" because the account row is only (...last4).
function parseChaseTransferOut_(subject, text) {
  var subjectLine = String(subject || '');
  var body = normalizeText_(text);
  var combined = normalizeText_(subjectLine + '\n' + body);

  var account = body.match(/(?:^|\n)\s*Account(?:\s+ending\s+in)?\b\s*:?\s*([^\n]*?)\s*\(?\s*(?:\u2026|\.{3})\s*(\d{4})\s*\)?\s*(?:\n|$)/i);
  var date = body.match(/(?:^|\n)\s*Sent on\b\s*:?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},\s*\d{4})/i);
  var recipient = body.match(/(?:^|\n)\s*Recipient\b\s*:?\s*([^\n]+)/i);
  var amount = body.match(/(?:^|\n)\s*Amount\b\s*:?\s*(\$[\d,]+\.\d{2})/i);

  // Subject: "You sent $250.00 from account ending in (...5678)"
  var subjectMatch = subjectLine.match(/You sent\s+(\$[\d,]+(?:\.\d{2})?)\s+from account ending in\s*\(?\s*(?:\u2026|\.{3})\s*(\d{4})\s*\)?/i);
  // Headline: "You sent $250.00 to SAMPLE CREDIT UNION"
  var headline = combined.match(/You sent\s+(\$[\d,]+(?:\.\d{2})?)\s+to\s+([^\n]+)/i);

  if (!recipient && headline) recipient = [null, headline[2]];
  if (!amount && subjectMatch) amount = [null, subjectMatch[1]];
  if (!amount && headline) amount = [null, headline[1]];

  if (!date || !recipient || !amount) {
    return { outcome: 'needs_review', institution: 'Chase', reason: 'Unsupported Chase alert format' };
  }

  var parsedDate = parseMonthNameDate_(date[1]);
  var parsedAmount = parseAmount_(amount[1]);
  if (!parsedDate || !Number.isFinite(parsedAmount)) {
    return { outcome: 'needs_review', institution: 'Chase', reason: 'Invalid Chase date or amount' };
  }

  var last4 = account ? account[2] : (subjectMatch ? subjectMatch[2] : '');

  return { outcome: 'imported', transaction: {
    transactionDate: parsedDate,
    institution: 'Chase',
    cardType: 'transfer',
    last4: last4,
    cardholder: '',
    merchant: String(recipient[1]).trim(),
    amount: parsedAmount,
    eventType: 'transfer_out'
  }};
}

// Chase credit and debit purchase alerts both render each field as a nested
// two-cell HTML table row. After htmlToText_, labels and values often land on
// consecutive lines (source newlines between </td><td>), so field regexes use
// \s* to bridge that. Credit labels: Account / Date / Merchant / Amount.
// Debit labels: Account ending in / Made on / Description / Amount.
// Subject (credit) or subject+headline (debit) are fallbacks only.
function parseChasePurchase_(subject, text) {
  var subjectLine = String(subject || '');
  var body = normalizeText_(text);
  var combined = normalizeText_(subjectLine + '\n' + body);

  var account = body.match(/(?:^|\n)\s*Account(?:\s+ending\s+in)?\b\s*:?\s*([^\n]*?)\s*\(?\s*\.{3}\s*(\d{4})\s*\)?\s*(?:\n|$)/i);
  var date = body.match(/(?:^|\n)\s*(?:Date|Made on)\b\s*:?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},\s*\d{4})/i);
  var merchant = body.match(/(?:^|\n)\s*(?:Merchant|Description)\b\s*:?\s*([^\n]+)/i);
  var amount = body.match(/(?:^|\n)\s*Amount\b\s*:?\s*(\$[\d,]+\.\d{2})/i);

  // Credit: "You made a $12.34 transaction with SAMPLE*COFFEE SHOP"
  var creditSubject = subjectLine.match(/You made a\s+(\$[\d,]+(?:\.\d{2})?)\s+transaction with\s+(.+?)\s*$/i);
  // Debit subject carries amount only; merchant is in the body headline.
  var debitSubjectAmount = subjectLine.match(/debit card transaction of\s+(\$[\d,]+(?:\.\d{2})?)/i);
  var debitHeadline = combined.match(/You made a debit card transaction of\s+(\$[\d,]+(?:\.\d{2})?)\s+with\s+([^\n]+)/i);

  if (!merchant && creditSubject) merchant = [null, creditSubject[2]];
  if (!amount && creditSubject) amount = [null, creditSubject[1]];
  if (!merchant && debitHeadline) merchant = [null, debitHeadline[2]];
  if (!amount && debitSubjectAmount) amount = [null, debitSubjectAmount[1]];
  if (!amount && debitHeadline) amount = [null, debitHeadline[1]];

  if (!date || !merchant || !amount) {
    return { outcome: 'needs_review', institution: 'Chase', reason: 'Unsupported Chase alert format' };
  }

  var parsedDate = parseMonthNameDate_(date[1]);
  var parsedAmount = parseAmount_(amount[1]);
  if (!parsedDate || !Number.isFinite(parsedAmount)) {
    return { outcome: 'needs_review', institution: 'Chase', reason: 'Invalid Chase date or amount' };
  }

  // Debit alerts put only "(...1234)" in the account row — no product name —
  // so cardType becomes "debit" from the alert wording rather than inventing one.
  var accountName = account ? String(account[1]).trim() : '';
  var cardType = accountName
    ? accountName.toLowerCase()
    : (/debit card/i.test(combined) ? 'debit' : '');

  return { outcome: 'imported', transaction: {
    transactionDate: parsedDate,
    institution: 'Chase',
    cardType: cardType,
    last4: account ? account[2] : '',
    cardholder: '',
    merchant: String(merchant[1]).trim(),
    amount: parsedAmount,
    eventType: 'purchase_authorization'
  }};
}

// Venmo P2P alerts: "You paid NAME $X.XX" (payment) or "NAME paid you $X.XX"
// (received). The hero amount is split across divs ($ / dollars / hidden "." /
// cents), so subject is the reliable amount source; body Date + optional
// "account ending in ####" from Payment Method fill the rest. Merchant is the
// counterparty. No cardholder is present.
function parseVenmo_(subject, text) {
  var subjectLine = String(subject || '').trim();
  var body = normalizeText_(text);

  var paymentSubject = subjectLine.match(/^You paid\s+(.+?)\s+(\$[\d,]+(?:\.\d{2})?)\s*$/i);
  var incomeSubject = subjectLine.match(/^(.+?)\s+paid you\s+(\$[\d,]+(?:\.\d{2})?)\s*$/i);

  var isPayment = false;
  var isReceived = false;
  var merchant = '';
  var amountStr = '';

  if (paymentSubject) {
    isPayment = true;
    merchant = paymentSubject[1];
    amountStr = paymentSubject[2];
  } else if (incomeSubject) {
    isReceived = true;
    merchant = incomeSubject[1];
    amountStr = incomeSubject[2];
  } else {
    var youPaid = body.match(/(?:^|\n)\s*You paid\s+([^\n]+?)\s*(?:\n|$)/i);
    var paidYou = body.match(/(?:^|\n)\s*([^\n]+?)\s+paid you\s*(?:\n|$)/i);
    if (youPaid) {
      isPayment = true;
      merchant = youPaid[1];
    } else if (paidYou) {
      isReceived = true;
      merchant = paidYou[1];
    }
  }

  if (!amountStr) {
    var bodyAmount = body.match(/\$\s*([\d,]+)\s*\.\s*(\d{2})/);
    if (bodyAmount) amountStr = '$' + bodyAmount[1] + '.' + bodyAmount[2];
  }

  // Do not require Date at line start — Gmail-synthesized plain text can put
  // "Transaction details Date Jun 05, 2026" on one line.
  var date = body.match(/\bDate\b\s*:?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},\s*\d{4})/i);
  var last4Match = body.match(/account ending in\s+(\d{4})/i);

  if (!isPayment && !isReceived) {
    return { outcome: 'needs_review', institution: 'Venmo', reason: 'Unsupported Venmo alert format' };
  }
  if (!merchant || !amountStr || !date) {
    return { outcome: 'needs_review', institution: 'Venmo', reason: 'Unsupported or incomplete Venmo alert' };
  }

  var parsedDate = parseMonthNameDate_(date[1]);
  var parsedAmount = parseAmount_(amountStr);
  if (!parsedDate || !Number.isFinite(parsedAmount)) {
    return { outcome: 'needs_review', institution: 'Venmo', reason: 'Invalid Venmo date or amount' };
  }

  return { outcome: 'imported', transaction: {
    transactionDate: parsedDate,
    institution: 'Venmo',
    cardType: isPayment ? 'payment' : 'received',
    last4: last4Match ? last4Match[1] : '',
    cardholder: '',
    merchant: String(merchant).trim(),
    amount: parsedAmount,
    eventType: isPayment ? 'venmo_payment' : 'venmo_payment_received'
  }};
}

// ===== appsscript/Workbook.gs =====
var TRANSACTION_HEADERS = ['Imported At','Transaction Date','Institution','Card Type','Last 4','Cardholder','Merchant','Amount','Gmail Message ID','Email Received At','Event Type','Parser Version','Fingerprint'];
// 'Subject' and 'From' are recorded so a reviewer can judge an issue without
// opening Gmail. Subject only -- never the body, per the privacy constraints.
var ISSUE_HEADERS = ['Gmail Message ID','Email Received At','Institution','Subject','From','Reason','Open in Gmail','Parser Version'];

function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActive(); var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  else ensureHeaders_(sheet, headers);
  sheet.setFrozenRows(1); return sheet;
}

// Adds any required header this sheet does not have yet, to the right of the
// existing ones. Sheets created by an older version keep working: their columns
// stay put, new ones are appended, and nothing is reordered or overwritten.
// Returns the number of headers added.
function ensureHeaders_(sheet, headers) {
  var width = Math.max(sheet.getLastColumn(), 1);
  var existing = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (v) { return String(v).trim(); });
  var missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
  missing.forEach(function (header, i) { sheet.getRange(1, width + 1 + i).setValue(header); });
  return missing.length;
}

// Resolves each required header to its actual column number, so user-added
// columns anywhere in the sheet cannot shift the script's writes.
function getColumnMap_(sheet, headers) {
  var width = Math.max(sheet.getLastColumn(), headers.length);
  var headerRow = sheet.getRange(1, 1, 1, width).getValues()[0];
  var map = {};
  headerRow.forEach(function (name, i) {
    var key = String(name).trim();
    if (key && !Object.prototype.hasOwnProperty.call(map, key)) map[key] = i + 1;
  });
  var missing = headers.filter(function (h) { return !map[h]; });
  if (missing.length) {
    throw new Error('The ' + sheet.getName() + ' header row is missing required column(s): ' + missing.join(', ') +
      '. Restore the header text exactly, then run Setup / Initialize.');
  }
  return map;
}

// The last row in use in any SCRIPT-OWNED column, which is the append anchor.
//
// Two failure modes this deliberately avoids:
//   1. getLastRow() counts user columns, so a formula filled to row 500 would
//      push new transactions to row 501, far below the visible data.
//   2. Scanning only 'Gmail Message ID' would skip rows the user typed by hand
//      (a cash purchase has no message ID), and the next import would overwrite
//      them. Manual rows fill Transaction Date / Merchant / Amount, which ARE
//      script-owned, so checking every owned column sees them.
function lastUsedScriptRow_(sheet, map) {
  return lastUsedRowIn_(sheet, TRANSACTION_HEADERS, map);
}

// Generic form of the above, used for any sheet the script appends to.
function lastUsedRowIn_(sheet, headers, map) {
  var maxRows = sheet.getMaxRows();
  if (maxRows < 2) return 1;
  var owned = headers.map(function (h) { return map[h]; });
  var minCol = Math.min.apply(null, owned);
  var maxCol = Math.max.apply(null, owned);
  // One read across the owned span; user columns inside it are simply not inspected.
  var values = sheet.getRange(2, minCol, maxRows - 1, maxCol - minCol + 1).getValues();
  var offsets = owned.map(function (c) { return c - minCol; });
  for (var i = values.length - 1; i >= 0; i--) {
    for (var j = 0; j < offsets.length; j++) {
      if (String(values[i][offsets[j]]).trim() !== '') return i + 2;
    }
  }
  return 1;
}

function initializeWorkbook() {
  var ss = SpreadsheetApp.getActive();
  var isNewSheet = !ss.getSheetByName('Transactions');
  var tx = getOrCreateSheet_('Transactions', TRANSACTION_HEADERS);
  var map = getColumnMap_(tx, TRANSACTION_HEADERS);
  tx.getRange(1, map['Imported At'], tx.getMaxRows(), 1).setNumberFormat('yyyy-mm-dd hh:mm');
  tx.getRange(1, map['Transaction Date'], tx.getMaxRows(), 1).setNumberFormat('yyyy-mm-dd');
  tx.getRange(1, map['Amount'], tx.getMaxRows(), 1).setNumberFormat('$#,##0.00');
  // Only hide audit columns on first creation; never re-hide columns the user unhid.
  if (isNewSheet) {
    ['Gmail Message ID','Email Received At','Event Type','Parser Version','Fingerprint']
      .forEach(function (h) { tx.hideColumns(map[h], 1); });
  }
  getOrCreateSheet_('Setup', ['Setting','Value']); getOrCreateSheet_('Import Issues', ISSUE_HEADERS);
  ensureImportToggles_();
  ensureLabels_(); setStatus_('Initialized', new Date());
}
function transactionValues_(tx, message, fingerprint) {
  return {
    'Imported At': new Date().toISOString(),
    'Transaction Date': tx.transactionDate,
    'Institution': tx.institution,
    'Card Type': tx.cardType,
    'Last 4': tx.last4,
    'Cardholder': tx.cardholder,
    'Merchant': tx.merchant,
    'Amount': tx.amount,
    'Gmail Message ID': message.id,
    'Email Received At': message.receivedAt,
    'Event Type': tx.eventType,
    'Parser Version': APP_CONFIG.parserVersion,
    'Fingerprint': fingerprint
  };
}
function hasMessageId_(id) {
  var s = SpreadsheetApp.getActive().getSheetByName('Transactions');
  if (!s || s.getMaxRows() < 2) return false;
  var map = getColumnMap_(s, TRANSACTION_HEADERS);
  var last = lastUsedScriptRow_(s, map);
  if (last < 2) return false;
  return s.getRange(2, map['Gmail Message ID'], last - 1, 1).getValues()
    .some(function (r) { return String(r[0]) === String(id); });
}
function appendTransaction_(tx, message, fingerprint) {
  var s = getOrCreateSheet_('Transactions', TRANSACTION_HEADERS);
  var map = getColumnMap_(s, TRANSACTION_HEADERS);
  var row = lastUsedScriptRow_(s, map) + 1;
  if (row > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), 1);
  var values = transactionValues_(tx, message, fingerprint);
  // Written cell-by-cell so user columns between/around them keep their formulas.
  TRANSACTION_HEADERS.forEach(function (header) {
    s.getRange(row, map[header]).setValue(values[header]);
  });
}
// Single-line, length-capped text for a spreadsheet cell. A leading =, +, - or
// @ is prefixed with an apostrophe so an odd subject line cannot be interpreted
// as a formula.
function safeCellText_(value, limit) {
  var text = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit || 300);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function recordIssue_(message, institution, reason) {
  var s = getOrCreateSheet_('Import Issues', ISSUE_HEADERS);
  var map = getColumnMap_(s, ISSUE_HEADERS);
  var row = lastUsedRowIn_(s, ISSUE_HEADERS, map) + 1;
  if (row > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), 1);
  var values = {
    'Gmail Message ID': message.id,
    'Email Received At': message.receivedAt,
    'Institution': institution || '',
    // Subject and sender only -- never the body.
    'Subject': safeCellText_(message.subject, 250),
    'From': safeCellText_(message.from, 120),
    'Reason': safeCellText_(reason || 'Unknown parse failure', 300),
    'Open in Gmail': message.id ? 'https://mail.google.com/mail/u/0/#all/' + message.id : '',
    'Parser Version': APP_CONFIG.parserVersion
  };
  // Cell-by-cell into mapped columns, so notes a reviewer adds in their own
  // columns are never overwritten.
  ISSUE_HEADERS.forEach(function (header) { s.getRange(row, map[header]).setValue(values[header]); });
}
function setStatus_(key, value) {
  var s = getOrCreateSheet_('Setup', ['Setting','Value']); var values = s.getDataRange().getValues();
  for (var i=1;i<values.length;i++) if (values[i][0] === key) { s.getRange(i+1,2).setValue(value); return; }
  s.appendRow([key,value]);
}

// TRUE / true / 1 / boolean true → enabled. Blank and anything else → disabled.
function isEnabledSetting_(value) {
  if (value === true || value === 1) return true;
  var s = String(value == null ? '' : value).trim().toLowerCase();
  return s === 'true' || s === '1';
}

// Returns the raw Value for a Setup key, or null if the key row is absent.
function readSetupSetting_(key) {
  var s = SpreadsheetApp.getActive().getSheetByName('Setup');
  if (!s) return null;
  var values = s.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === key) return values[i][1];
  }
  return null;
}

function importToggleKey_(institution) {
  var toggles = APP_CONFIG.importToggles;
  var keys = Object.keys(toggles);
  for (var i = 0; i < keys.length; i++) {
    if (toggles[keys[i]] === institution) return keys[i];
  }
  return null;
}

// Missing Setup row → enabled (older sheets before ensureImportToggles_ runs).
// Present but blank/FALSE → disabled.
function isInstitutionEnabled_(institution) {
  var key = importToggleKey_(institution);
  if (!key) return true;
  var value = readSetupSetting_(key);
  if (value === null) return true;
  return isEnabledSetting_(value);
}

// Seed Import USAA / Chase / Venmo as TRUE if absent. Never overwrite a Value.
function ensureImportToggles_() {
  var s = getOrCreateSheet_('Setup', ['Setting', 'Value']);
  var values = s.getDataRange().getValues();
  var existing = {};
  for (var i = 1; i < values.length; i++) existing[String(values[i][0])] = true;
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['TRUE', 'FALSE'], true)
    .setAllowInvalid(false)
    .build();
  Object.keys(APP_CONFIG.importToggles).forEach(function (key) {
    if (existing[key]) return;
    s.appendRow([key, true]);
    s.getRange(s.getLastRow(), 2).setDataValidation(rule);
  });
}

function enabledTrustedSenders_() {
  var all = APP_CONFIG.trustedSenders;
  var out = {};
  Object.keys(all).forEach(function (email) {
    if (isInstitutionEnabled_(all[email])) out[email] = all[email];
  });
  return out;
}

// ===== appsscript/GmailIntake.gs =====
function isTrustedSender_(sender) { return trustedInstitution_(sender) !== null; }
function ensureLabels_() {
  Object.keys(APP_CONFIG.labels).forEach(function(k){ GmailApp.getUserLabelByName(APP_CONFIG.labels[k]) || GmailApp.createLabel(APP_CONFIG.labels[k]); });
}
function buildGmailQuery_() {
  var enabled = enabledTrustedSenders_();
  var emails = Object.keys(enabled);
  // No enabled institutions: match nothing rather than searching every sender.
  if (emails.length === 0) return 'label:"__gmail_transaction_alerts_none__"';
  var senders = emails.map(function(s){return 'from:'+s;}).join(' OR ');
  var query = 'newer_than:30d ('+senders+') -label:"'+APP_CONFIG.labels.imported+'" -label:"'+APP_CONFIG.labels.ignored+'" -label:"'+APP_CONFIG.labels.review+'"';
  var source = PropertiesService.getUserProperties().getProperty('SOURCE_LABEL');
  return source ? query+' label:"'+source.replace(/"/g,'')+'"' : query;
}
function fingerprint_(tx) { return [tx.institution,tx.transactionDate,tx.last4,tx.amount,String(tx.merchant).toUpperCase()].join('|'); }
function messageModel_(message) {
  return {
    id: message.getId(),
    receivedAt: message.getDate().toISOString(),
    subject: message.getSubject(),
    from: normalizeSender_(message.getFrom())
  };
}
function importTransactionAlerts() {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return;
  var counts={imported:0,ignored:0,review:0,errors:0};
  try {
    initializeWorkbook(); var labels={}; Object.keys(APP_CONFIG.labels).forEach(function(k){labels[k]=GmailApp.getUserLabelByName(APP_CONFIG.labels[k]);});
    GmailApp.search(buildGmailQuery_(),0,50).forEach(function(thread){ thread.getMessages().forEach(function(msg){
      var sender=normalizeSender_(msg.getFrom());
      var institution=trustedInstitution_(sender);
      if (!institution) return;
      // Defense in depth: skip unlabeled if a disabled institution still appears.
      if (!isInstitutionEnabled_(institution)) return;
      var model=messageModel_(msg); if (hasMessageId_(model.id)) { thread.addLabel(labels.imported); return; }
      try {
        var parsed=parseAlert(sender,msg.getSubject(),msg.getBody(),msg.getPlainBody());
        if(parsed.outcome==='imported'){ appendTransaction_(parsed.transaction,model,fingerprint_(parsed.transaction)); thread.addLabel(labels.imported); counts.imported++; setStatus_('Last Imported Transaction',parsed.transaction.transactionDate+' '+parsed.transaction.merchant); }
        else if(parsed.outcome==='ignored'){ thread.addLabel(labels.ignored); counts.ignored++; }
        else { recordIssue_(model,parsed.institution || trustedInstitution_(sender),parsed.reason); thread.addLabel(labels.review); counts.review++; }
      } catch(e) {
        // No terminal label, so the message is retried next run. Counted and
        // timestamped because a swallowed failure here looks exactly like
        // "nothing is importing" from the user's side.
        counts.errors++;
        setStatus_('Last Error','Retryable error: '+String(e.message||e).slice(0,200));
        setStatus_('Last Error At', new Date());
      }
    }); });
    setStatus_('Last Checked',new Date()); setStatus_('Last Result',JSON.stringify(counts));
  } finally { lock.releaseLock(); }
}
function importNow(){ importTransactionAlerts(); }

// ===== appsscript/Triggers.gs =====
function validateInterval_(minutes) {
  var n=Number(minutes); if(APP_CONFIG.supportedIntervals.indexOf(n)<0) throw new Error('Interval must be 1, 5, 10, 15, 30, or 60 minutes'); return n;
}
function removeIntakeTriggers_(){ ScriptApp.getProjectTriggers().forEach(function(t){if(t.getHandlerFunction()==='importTransactionAlerts') ScriptApp.deleteTrigger(t);}); }
function installSchedule(minutes){ var n=validateInterval_(minutes); removeIntakeTriggers_(); ScriptApp.newTrigger('importTransactionAlerts').timeBased().everyMinutes(n).create(); PropertiesService.getUserProperties().setProperty('POLL_MINUTES',String(n)); setStatus_('Automatic Import','Every '+n+' minute(s)'); }
function disableAutomaticImport(){ removeIntakeTriggers_(); PropertiesService.getUserProperties().deleteProperty('POLL_MINUTES'); setStatus_('Automatic Import','Disabled'); }
function schedule1(){installSchedule(1);} function schedule5(){installSchedule(5);} function schedule10(){installSchedule(10);} function schedule15(){installSchedule(15);} function schedule30(){installSchedule(30);} function schedule60(){installSchedule(60);}

// ===== appsscript/Menu.gs =====
function onOpen(){
  SpreadsheetApp.getUi().createMenu('Transaction Alerts')
    .addItem('Setup / Initialize','initializeWorkbook').addItem('Import Now','importNow')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Automatic Import').addItem('Every minute','schedule1').addItem('Every 5 minutes','schedule5').addItem('Every 10 minutes','schedule10').addItem('Every 15 minutes','schedule15').addItem('Every 30 minutes','schedule30').addItem('Every hour','schedule60'))
    .addItem('Disable Automatic Import','disableAutomaticImport').addSeparator()
    .addItem('Reprocess Selected Issue','reprocessSelectedIssue')
    .addItem('Go To Last Imported Row','goToLastImportedRow')
    .addItem('Diagnostics','showDiagnostics').addToUi();
}
function reprocessSelectedIssue(){
  var s=SpreadsheetApp.getActiveSheet(); if(s.getName()!=='Import Issues'||s.getActiveRange().getRow()<2) throw new Error('Select an Import Issues row first.');
  var map=getColumnMap_(s,ISSUE_HEADERS);
  var row=s.getActiveRange().getRow(), id=String(s.getRange(row,map['Gmail Message ID']).getValue()), msg=GmailApp.getMessageById(id); if(!msg||!isTrustedSender_(msg.getFrom())) throw new Error('Trusted source message was not found.');
  var label=GmailApp.getUserLabelByName(APP_CONFIG.labels.review); msg.getThread().removeLabel(label); s.deleteRow(row); importTransactionAlerts();
}
// Jumps the cursor to the last imported row. Rows written by older versions of
// this script can sit hundreds of rows below the visible data; this finds them
// without the user guessing where to scroll.
function goToLastImportedRow(){
  var ss=SpreadsheetApp.getActive(), sheet=ss.getSheetByName('Transactions');
  if(!sheet) throw new Error('No Transactions sheet yet. Run Setup / Initialize.');
  var map=getColumnMap_(sheet,TRANSACTION_HEADERS);
  var last=lastUsedScriptRow_(sheet,map);
  if(last<2){ SpreadsheetApp.getUi().alert('No imported rows yet.'); return; }
  sheet.activate();
  sheet.setActiveRange(sheet.getRange(last,1,1,sheet.getLastColumn()||TRANSACTION_HEADERS.length));
  SpreadsheetApp.getActive().toast('Last imported row: '+last,'Transaction Alerts',8);
}

function getStatus_(key){
  var s=SpreadsheetApp.getActive().getSheetByName('Setup'); if(!s) return '';
  var values=s.getDataRange().getValues();
  for(var i=1;i<values.length;i++) if(values[i][0]===key) return String(values[i][1]);
  return '';
}

// Answers the question users actually have: "the script says it imported
// something, so where is it?" Reports the header check, the row count, and the
// exact row the next import will write to.
function showDiagnostics(){
  ensureLabels_();
  var lines=[];
  var triggerCount=ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='importTransactionAlerts';}).length;
  var sheet=SpreadsheetApp.getActive().getSheetByName('Transactions');

  // Gmail labels are account-wide but writes go to THIS spreadsheet, so a user
  // with two copies of the workbook can see labeled mail and an empty sheet.
  lines.push('Workbook: '+SpreadsheetApp.getActive().getName());
  lines.push('Workbook ID: '+SpreadsheetApp.getActive().getId());
  lines.push('Parser: '+APP_CONFIG.parserVersion);
  lines.push('Import triggers: '+triggerCount);
  lines.push('Import toggles:');
  Object.keys(APP_CONFIG.importToggles).forEach(function(k){
    lines.push('  '+k+': '+(isInstitutionEnabled_(APP_CONFIG.importToggles[k]) ? 'TRUE' : 'FALSE'));
  });
  lines.push('Trusted senders:');
  Object.keys(APP_CONFIG.trustedSenders).forEach(function(k){ lines.push('  '+k+' -> '+APP_CONFIG.trustedSenders[k]); });

  if(!sheet){
    lines.push('\nTransactions sheet: MISSING. Run Setup / Initialize.');
  } else {
    try {
      var map=getColumnMap_(sheet,TRANSACTION_HEADERS);
      var last=lastUsedScriptRow_(sheet,map);
      lines.push('\nHeader row: OK (all 13 columns found)');
      lines.push('Rows in use: '+Math.max(0,last-1));
      lines.push('Next import writes to row: '+(last+1));
      lines.push('Sheet last row (incl. your formulas): '+sheet.getLastRow());
      if(sheet.getLastRow()>last+1){
        lines.push('NOTE: your formulas extend past the data. That is fine --');
        lines.push('imports are placed by the columns above, not by that number.');
      }
    } catch(e){
      lines.push('\nHEADER ROW PROBLEM -- imports cannot be written:');
      lines.push('  '+String(e.message||e));
    }
  }

  var lastError=getStatus_('Last Error');
  lines.push('\nLast checked: '+(getStatus_('Last Checked')||'never'));
  lines.push('Last result: '+(getStatus_('Last Result')||'n/a'));
  lines.push('Last imported: '+(getStatus_('Last Imported Transaction')||'none'));
  if(lastError) lines.push('LAST ERROR ('+(getStatus_('Last Error At')||'unknown time')+'): '+lastError);

  SpreadsheetApp.getUi().alert('Transaction Alerts Diagnostics',lines.join('\n'),SpreadsheetApp.getUi().ButtonSet.OK);
}
