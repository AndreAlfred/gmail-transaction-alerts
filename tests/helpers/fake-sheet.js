/**
 * Minimal stand-in for a Google Sheets Sheet object.
 *
 * Implements only the surface the workbook code touches, so the append-anchor
 * logic can be exercised under Node. Rows and columns are 1-indexed, matching
 * the real API. Empty cells are '' as they are in Apps Script.
 */
class FakeSheet {
  /** @param {Array<Array<*>>} grid Row 1 is the header row. */
  constructor(grid) {
    this.grid = grid.map((row) => row.slice());
  }

  getMaxRows() { return this.grid.length; }

  getLastColumn() {
    return this.grid.reduce((widest, row) => {
      let last = 0;
      row.forEach((cell, i) => { if (String(cell).trim() !== '') last = i + 1; });
      return Math.max(widest, last);
    }, 0);
  }

  /** Whole-sheet last row, i.e. the trap the old code fell into. */
  getLastRow() {
    for (let r = this.grid.length - 1; r >= 0; r--) {
      if (this.grid[r].some((cell) => String(cell).trim() !== '')) return r + 1;
    }
    return 0;
  }

  getRange(row, col, numRows = 1, numCols = 1) {
    const sheet = this;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const line = [];
          for (let c = 0; c < numCols; c++) line.push(sheet.cell(row + r, col + c));
          out.push(line);
        }
        return out;
      },
      getValue() { return sheet.cell(row, col); },
      setValue(value) { sheet.write(row, col, value); return this; },
      setValues(values) {
        values.forEach((line, r) => line.forEach((v, c) => sheet.write(row + r, col + c, v)));
        return this;
      },
      setNumberFormat() { return this; }
    };
  }

  cell(row, col) {
    const line = this.grid[row - 1];
    if (!line) return '';
    const value = line[col - 1];
    return value === undefined ? '' : value;
  }

  write(row, col, value) {
    while (this.grid.length < row) this.grid.push([]);
    const line = this.grid[row - 1];
    while (line.length < col) line.push('');
    line[col - 1] = value;
  }

  insertRowsAfter(afterRow, howMany) {
    for (let i = 0; i < howMany; i++) this.grid.splice(afterRow + i, 0, []);
    return this;
  }

  setFrozenRows() { return this; }
  hideColumns() { return this; }
}

module.exports = { FakeSheet };
