# LESSONS.md

Durable lessons from working on this repository — the non-obvious things that cost time, and what to do about them next time. Each entry states the lesson, why it bit us, and how to apply it.

This is a living file. Add to it when a bug or review turns up something that wasn't obvious from reading the code. Do not add generic programming advice; only record what is specific to this project or to the environments it runs in (Google Apps Script, Gmail, Google Sheets).

---

## Sheets

### `getLastRow()` means "last row with anything in it", not "last row I wrote"

**What happened.** New transactions stopped appearing on the Transactions tab, even though the Setup tab correctly reported the newest one as *Last Imported Transaction*. The parse and the write were both succeeding. The user had added categorization columns and filled formulas down to a few hundred rows; `getLastRow()` counted those, so `getLastRow() + 1` appended each new row hundreds of rows below the real data, where nobody scrolled.

**Why it matters.** The failure is invisible. Nothing throws, the status line updates, dedup still works — the data is simply somewhere the user never looks. It is easy to misdiagnose as a parser failure and go rewrite a regex that was never broken.

**How to apply.** Anchor appends to a column that *only the script writes* — here, `Gmail Message ID` — and scan it bottom-up (`lastScriptRow_`). Never use `getLastRow()` as an append anchor on a sheet a user can edit. The same caution applies to `getDataRange()` and `appendRow()`, which have the same whole-sheet notion of "last".

### Hidden columns make "add a column to the right" ambiguous

**What happened.** Columns I–M are hidden audit fields. To the user, column H (`Amount`) looks like the last column, so "I added columns to the right of the data" actually meant *inserted into the middle of the script's block*, silently shifting every hard-coded index. This is also why one added column worked and a later one didn't — the outcome depends entirely on where the insert landed.

**How to apply.** Resolve columns by header name at run time (`getColumnMap_`), never by literal index. If a required header is missing, fail loudly and name it rather than writing to the wrong place. Treat any literal column number in a `getRange` call as a bug.

### Write cell-by-cell when user formulas share the row

**Why.** A fixed-width `setValues([...])` spanning the script's columns will overwrite anything a user placed between them, and writing `null` into a cell clears a formula. Per-cell `setValue` into mapped columns is slower but preserves the user's work. At a handful of transactions per run, the cost is irrelevant — correctness wins.

### Only apply cosmetic sheet changes on first creation

**Why.** `initializeWorkbook()` runs on *every* import. Re-hiding audit columns each time would fight a user who deliberately unhid them. Check whether the sheet already existed before applying formatting or visibility.

---

## Parsing

### Diagnose from the audit trail before touching a regex

The Setup tab said the transaction imported; the Transactions tab didn't show it. That pair of facts localizes the bug precisely — parsing succeeded, placement failed — and rules out the parser without reading a line of it. Check what the script recorded about its own run first.

### Let the HTML-to-text normalizer do the structural work

Chase renders each field as a two-cell table row (`<td>Merchant</td><td>SAMPLE*COFFEE SHOP</td>`). Because `htmlToText_` converts every `</tr>` to a newline and every remaining tag to a space, each field lands on its own line as `Label Value`. Anchoring regexes to line boundaries (`(?:^|\n)\s*Merchant\b`) is then both simple and robust.

The alternative — regexing across the raw blob — would match the wrong things. This email body contains `manage your account` and `status of your accounts` in the footer, and a `$0.01` threshold amount *after* the real amount. Line anchoring plus first-match wins avoids all of it.

### Prefer a fallback source over a failed parse, but never invent a value

Merchant and amount also appear in the subject line, so the body parser falls back to it if the field table changes shape. That is recovering a value from a second real source — not the same as fabricating one. Chase alerts genuinely contain no cardholder name, so that field is left empty. Missing data goes to Needs Review or stays blank; it never gets guessed.

### Never widen the sender allowlist to make a parser work

The allowlist is a security boundary, not a convenience. A lookalike sender (`alerts@chase.com.example.net`) must be rejected even when the message body parses perfectly — there is a test asserting exactly this. If a legitimate email is being rejected, fix the sender entry, don't loosen the match.

---

## Fixtures and privacy

### A real merchant and amount are personal data

Redaction attention naturally goes to card numbers and names, but `CTLP*CANTEEN VENDING` / `$1.50` is a record of a real person's real purchase, and it had spread into doc prose and code comments — not just the fixture. Before publishing anything, grep for the real merchant string, the real last-4, and the account email across *all* files, including comments and Markdown.

### Fixtures must preserve structure, not content

A redacted fixture is only useful if it still exercises the real parsing path. Keep the tag nesting, field labels, whitespace, and quirks (including the unclosed `<a>` tag in Chase's date cell); replace only the values, with obviously fictitious ones.

---

## Apps Script and testing

### Apps Script files are plain scripts, not modules

There is no `require`/`export`. To test them under Node, evaluate the source in a `node:vm` context and read the resulting globals. Load `Config`/`Text`/`Parsers` only — the Workbook, Gmail, and Trigger functions reference Apps Script globals that don't exist in Node, which is fine as long as nothing calls them.

### `deepStrictEqual` compares prototypes across realms

An object built inside a `vm` context carries *that context's* `Object.prototype`, so `deepStrictEqual` fails with "same structure but not reference-equal" while printing two identical-looking objects. Spread the value into the host realm (`{ ...result.transaction }`) before asserting. Worth recognizing on sight — the error message is genuinely confusing.

### `node --test <dir>` is not portable

On Node 25 a bare directory argument is resolved as a module and throws `MODULE_NOT_FOUND`, which looks like a failing test but isn't. Pass explicit file paths or a glob.

---

## Repository hygiene

### Duplicated files drift

`gmail-transaction-alerts-Code.txt` exists only so the script can be opened on an iPad, and it is a byte-identical copy of the `.gs`. The same applies to `AGENTS.md` and `CLAUDE.md`. Any duplicate is a drift hazard: name one copy authoritative, and regenerate the others as a required step of every change rather than editing them in parallel.

### Verify from the location you'll actually ship from

The tests were re-run after copying the project into the git repo, not just in the original folder. Copy steps are exactly where a missing fixture or a bad relative path hides.
