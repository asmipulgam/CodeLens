import { describe, expect, it } from 'vitest';
import { csvCell, neutralizeFormula, toCsv, toTsv } from './csv';

describe('spreadsheet-safe CSV', () => {
  it.each(['=HYPERLINK("http://evil")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])(
    'neutralises formula-looking cell %j',
    (value) => {
      expect(neutralizeFormula(value).startsWith("'")).toBe(true);
    },
  );

  it('leaves ordinary text and numbers alone', () => {
    expect(neutralizeFormula('North America')).toBe('North America');
    expect(csvCell(1234.5)).toBe('1234.5');
    expect(csvCell(-42)).toBe('-42');
  });

  it('still neutralises negative-looking text, which could be a formula like -2+3', () => {
    expect(csvCell('-2+3')).toBe("'-2+3");
  });

  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('Acme, Inc')).toBe('"Acme, Inc"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('renders null and undefined as empty cells', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]])).toBe('a,b\r\n,');
  });

  it('escapes formulas inside quoted cells too', () => {
    expect(csvCell('=1,2')).toBe(`"'=1,2"`);
  });

  it('builds TSV without tabs or newlines leaking into cells', () => {
    expect(toTsv(['name'], [['a\tb\nc']])).toBe('name\na b c');
    expect(toTsv(['f'], [['=cmd']])).toBe("f\n'=cmd");
  });
});
