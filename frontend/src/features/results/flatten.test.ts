import { describe, expect, it } from 'vitest';
import { documentsToTable, flattenDocument, summarizeArray } from './flatten';

describe('document flattening', () => {
  it('flattens nested objects into dot paths', () => {
    expect(flattenDocument({ a: 1, b: { c: 'x', d: { e: true } }, f: [1, 2] })).toEqual({
      a: 1,
      'b.c': 'x',
      'b.d.e': true,
      f: [1, 2],
    });
  });

  it('summarises arrays', () => {
    expect(summarizeArray(['a', 'b'])).toBe('a, b');
    expect(summarizeArray([1, 2, 3, 4, 5, 6, 7])).toBe('1, 2, 3, 4, 5 … (+2)');
    expect(summarizeArray([{ a: 1 }, { a: 2 }])).toBe('2 items');
  });

  it('builds columns from the union of keys and marks masked paths', () => {
    const table = documentsToTable(
      [
        { id: 1, customer: { name: 'Acme', email: null } },
        { id: 2, customer: { name: 'Globex', email: null }, note: 'x' },
      ],
      ['customer.email'],
    );
    expect(table.columns.map((column) => column.key)).toEqual(['id', 'customer.name', 'customer.email', 'note']);
    expect(table.columns.find((column) => column.key === 'customer.email')?.masked).toBe(true);
    expect(table.columns.find((column) => column.key === 'id')?.type).toBe('number');
    expect(table.rows[0].note).toBeNull();
  });
});
