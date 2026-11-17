import { z } from 'zod';
import type { ConnectionValues, SourceType } from '@/api/types';

export interface FieldDef {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'password' | 'select' | 'checkbox' | 'secret-textarea';
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string | boolean;
  /** Secrets are write-only: sent once, stored in the backend's vault, never returned. */
  secret?: boolean;
  /** Show only when another field has a given value. */
  showIf?: { key: string; equals: string };
}

export interface SourceTypeDef {
  label: string;
  description: string;
  entityNoun: string;
  fields: FieldDef[];
}

const host: FieldDef = { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'db.internal.company.com' };
const port = (value: string): FieldDef => ({ key: 'port', label: 'Port', kind: 'number', required: true, defaultValue: value });
const database: FieldDef = { key: 'database', label: 'Database name', kind: 'text', required: true };
const username: FieldDef = {
  key: 'username',
  label: 'Username',
  kind: 'text',
  required: true,
  help: 'Use a dedicated read-only account for CodeLens.',
};
const password: FieldDef = { key: 'password', label: 'Password', kind: 'password', required: true, secret: true };

export const SOURCE_TYPES: Record<SourceType, SourceTypeDef> = {
  postgresql: {
    label: 'PostgreSQL',
    description: 'Open-source relational database',
    entityNoun: 'tables',
    fields: [
      host,
      port('5432'),
      database,
      username,
      password,
      {
        key: 'sslMode',
        label: 'TLS / SSL',
        kind: 'select',
        defaultValue: 'verify-full',
        options: [
          { value: 'verify-full', label: 'Verify certificate and hostname (recommended)' },
          { value: 'verify-ca', label: 'Verify certificate' },
          { value: 'require', label: 'Require encryption' },
        ],
      },
    ],
  },
  mysql: {
    label: 'MySQL',
    description: 'Relational database (also MariaDB)',
    entityNoun: 'tables',
    fields: [
      host,
      port('3306'),
      database,
      username,
      password,
      {
        key: 'tlsMode',
        label: 'TLS',
        kind: 'select',
        defaultValue: 'VERIFY_IDENTITY',
        options: [
          { value: 'VERIFY_IDENTITY', label: 'Verify certificate and hostname (recommended)' },
          { value: 'VERIFY_CA', label: 'Verify certificate' },
          { value: 'REQUIRED', label: 'Require encryption' },
        ],
      },
    ],
  },
  sqlserver: {
    label: 'SQL Server',
    description: 'Microsoft SQL Server or Azure SQL',
    entityNoun: 'tables',
    fields: [
      host,
      port('1433'),
      database,
      username,
      password,
      {
        key: 'encrypt',
        label: 'Encryption',
        kind: 'select',
        defaultValue: 'strict',
        options: [
          { value: 'strict', label: 'Strict (TDS 8.0, recommended)' },
          { value: 'mandatory', label: 'Mandatory' },
        ],
      },
    ],
  },
  oracle: {
    label: 'Oracle',
    description: 'Oracle Database',
    entityNoun: 'tables',
    fields: [
      host,
      port('1521'),
      { key: 'serviceName', label: 'Service name', kind: 'text', required: true, placeholder: 'ORCLPDB1' },
      username,
      password,
      { key: 'useTls', label: 'Use TLS (TCPS)', kind: 'checkbox', defaultValue: true },
    ],
  },
  snowflake: {
    label: 'Snowflake',
    description: 'Cloud data warehouse',
    entityNoun: 'tables',
    fields: [
      {
        key: 'account',
        label: 'Account identifier',
        kind: 'text',
        required: true,
        placeholder: 'myorg-myaccount',
        help: 'Found in Snowflake under Admin → Accounts.',
      },
      { key: 'warehouse', label: 'Warehouse', kind: 'text', required: true, placeholder: 'CODELENS_WH' },
      { key: 'database', label: 'Database', kind: 'text', required: true },
      { key: 'schema', label: 'Default schema', kind: 'text', placeholder: 'PUBLIC' },
      {
        key: 'role',
        label: 'Role',
        kind: 'text',
        required: true,
        placeholder: 'CODELENS_READER',
        help: 'A role with only SELECT/USAGE grants.',
      },
      { ...username },
      {
        key: 'authMethod',
        label: 'Authentication',
        kind: 'select',
        defaultValue: 'keypair',
        options: [
          { value: 'keypair', label: 'Key pair (recommended)' },
          { value: 'password', label: 'Password' },
        ],
      },
      {
        key: 'privateKey',
        label: 'Private key (PEM)',
        kind: 'secret-textarea',
        required: true,
        secret: true,
        showIf: { key: 'authMethod', equals: 'keypair' },
      },
      {
        key: 'privateKeyPassphrase',
        label: 'Private key passphrase',
        kind: 'password',
        secret: true,
        showIf: { key: 'authMethod', equals: 'keypair' },
      },
      { ...password, showIf: { key: 'authMethod', equals: 'password' } },
    ],
  },
  mongodb: {
    label: 'MongoDB',
    description: 'Document database (also Atlas)',
    entityNoun: 'collections',
    fields: [
      {
        key: 'hosts',
        label: 'Hosts',
        kind: 'text',
        required: true,
        placeholder: 'mongo1.internal:27017, mongo2.internal:27017',
        help: 'Comma-separated host:port list. Credentials go in the fields below, never in the host.',
      },
      { key: 'replicaSet', label: 'Replica set', kind: 'text', placeholder: 'rs0' },
      { ...database },
      { key: 'authSource', label: 'Authentication database', kind: 'text', defaultValue: 'admin' },
      username,
      password,
      { key: 'tls', label: 'Use TLS', kind: 'checkbox', defaultValue: true },
    ],
  },
  redis: {
    label: 'Redis',
    description: 'In-memory key-value store',
    entityNoun: 'key patterns',
    fields: [
      host,
      port('6379'),
      { key: 'dbIndex', label: 'Database number', kind: 'number', defaultValue: '0' },
      {
        key: 'username',
        label: 'ACL username',
        kind: 'text',
        required: true,
        help: 'Use an ACL user limited to read commands (e.g. +@read -@write).',
      },
      password,
      { key: 'tls', label: 'Use TLS', kind: 'checkbox', defaultValue: true },
    ],
  },
};

export type FormValues = Record<string, string | boolean>;

export function isFieldVisible(field: FieldDef, values: FormValues) {
  if (!field.showIf) return true;
  return values[field.showIf.key] === field.showIf.equals;
}

export function defaultConnectionValues(type: SourceType): FormValues {
  const values: FormValues = {};
  for (const field of SOURCE_TYPES[type].fields) {
    if (field.secret) continue;
    values[field.key] = field.defaultValue ?? (field.kind === 'checkbox' ? false : '');
  }
  return values;
}

const HOSTNAME = /^[a-zA-Z0-9.-]+$/;
const HOST_LIST = /^\s*[a-zA-Z0-9.-]+(:\d{1,5})?(\s*,\s*[a-zA-Z0-9.-]+(:\d{1,5})?)*\s*$/;

/**
 * Validates connection settings for a type. `existingSecrets` lists secrets already stored
 * (edit mode) so they don't need to be re-entered.
 */
export function validateConnection(
  type: SourceType,
  values: FormValues,
  secrets: Record<string, string>,
  existingSecrets: Set<string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of SOURCE_TYPES[type].fields) {
    if (!isFieldVisible(field, values)) continue;
    const raw = field.secret ? secrets[field.key] ?? '' : values[field.key];
    const text = typeof raw === 'string' ? raw.trim() : '';

    if (field.required && field.kind !== 'checkbox' && !text) {
      if (field.secret && existingSecrets.has(field.key)) continue;
      errors[field.key] = `${field.label} is required.`;
      continue;
    }
    if (!text) continue;

    if (field.kind === 'number') {
      const result = z.coerce.number().int().min(0).max(65_535).safeParse(text);
      if (!result.success) errors[field.key] = `${field.label} must be a whole number.`;
      else if (field.key === 'port' && result.data < 1) errors[field.key] = 'Port must be between 1 and 65535.';
    }
    if (field.key === 'host' && !HOSTNAME.test(text)) {
      errors[field.key] = 'Enter a hostname or IP address only (no protocol, path or credentials).';
    }
    if (field.key === 'hosts' && !HOST_LIST.test(text)) {
      errors[field.key] = 'Use host:port pairs separated by commas, with no credentials.';
    }
    if (field.key === 'privateKey' && !text.includes('PRIVATE KEY')) {
      errors[field.key] = 'Paste the full PEM private key, including the BEGIN/END lines.';
    }
  }
  return errors;
}

/** Converts form strings into typed connection values (numbers stay numbers). */
export function toConnectionValues(type: SourceType, values: FormValues): ConnectionValues {
  const out: ConnectionValues = {};
  for (const field of SOURCE_TYPES[type].fields) {
    if (field.secret || !isFieldVisible(field, values)) continue;
    const value = values[field.key];
    if (field.kind === 'number') {
      if (typeof value === 'string' && value.trim() !== '') out[field.key] = Number(value);
    } else if (typeof value === 'boolean') {
      out[field.key] = value;
    } else if (typeof value === 'string' && value.trim() !== '') {
      out[field.key] = value.trim();
    }
  }
  return out;
}

export function fromConnectionValues(type: SourceType, connection: ConnectionValues): FormValues {
  const values = defaultConnectionValues(type);
  for (const [key, value] of Object.entries(connection)) {
    values[key] = typeof value === 'number' ? String(value) : value;
  }
  return values;
}

/** Names that usually hold personal or confidential data; pre-marked as hidden for review. */
export const SENSITIVE_FIELD = /(e-?mail|phone|mobile|ssn|social|salary|wage|password|passwd|secret|token|dob|birth|address|street|postcode|zip|card|iban|account_?number|tax|passport|national_?id|ip_?address)/i;
