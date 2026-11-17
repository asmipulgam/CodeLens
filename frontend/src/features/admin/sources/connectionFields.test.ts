import { describe, expect, it } from 'vitest';
import { SENSITIVE_FIELD, defaultConnectionValues, toConnectionValues, validateConnection } from './connectionFields';

describe('connection validation', () => {
  it('requires fields and secrets for a new source', () => {
    const errors = validateConnection('postgresql', defaultConnectionValues('postgresql'), {}, new Set());
    expect(Object.keys(errors).sort()).toEqual(['database', 'host', 'password', 'username']);
  });

  it('does not require stored secrets again when editing', () => {
    const values = { ...defaultConnectionValues('postgresql'), host: 'db.internal', database: 'sales', username: 'reader' };
    expect(validateConnection('postgresql', values, {}, new Set(['password']))).toEqual({});
  });

  it('rejects credentials or protocols smuggled into the host', () => {
    const values = { ...defaultConnectionValues('postgresql'), host: 'user:pass@db.internal', database: 'x', username: 'y' };
    expect(validateConnection('postgresql', values, { password: 'p' }, new Set()).host).toBeDefined();
    const mongo = { ...defaultConnectionValues('mongodb'), hosts: 'mongodb://u:p@h:27017', database: 'x', username: 'y' };
    expect(validateConnection('mongodb', mongo, { password: 'p' }, new Set()).hosts).toBeDefined();
  });

  it('only validates fields that are visible for the chosen auth method', () => {
    const base = {
      ...defaultConnectionValues('snowflake'),
      account: 'org-acct',
      warehouse: 'WH',
      database: 'DB',
      role: 'READER',
      username: 'svc',
    };
    expect(validateConnection('snowflake', base, {}, new Set()).privateKey).toBeDefined();
    expect(validateConnection('snowflake', base, {}, new Set()).password).toBeUndefined();
    const withPassword = { ...base, authMethod: 'password' };
    expect(validateConnection('snowflake', withPassword, {}, new Set()).password).toBeDefined();
  });

  it('never puts secrets into connection values and converts numbers', () => {
    const values = { ...defaultConnectionValues('redis'), host: 'redis.internal', username: 'ro', password: 'leak' };
    const out = toConnectionValues('redis', values);
    expect(out).not.toHaveProperty('password');
    expect(out.port).toBe(6379);
  });

  it('flags likely-sensitive field names', () => {
    for (const name of ['email', 'customer_email', 'phone', 'salary', 'date_of_birth', 'iban', 'card_number']) {
      expect(SENSITIVE_FIELD.test(name)).toBe(true);
    }
    for (const name of ['region', 'order_total', 'status']) expect(SENSITIVE_FIELD.test(name)).toBe(false);
  });
});
