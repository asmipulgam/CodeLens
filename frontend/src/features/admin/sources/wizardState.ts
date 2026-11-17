import type {
  AdminSourceDetail,
  ConnectionTestResult,
  DiscoveredSchema,
  ExposedEntity,
  GlossaryTerm,
  SourceConfigInput,
  SourceType,
} from '@/api/types';
import {
  SOURCE_TYPES,
  defaultConnectionValues,
  fromConnectionValues,
  toConnectionValues,
  validateConnection,
  type FormValues,
} from './connectionFields';

export const STEPS = ['Database type', 'Connection', 'Test', 'Choose data', 'Describe', 'Access & cache'] as const;

export const CACHE_TTL_OPTIONS = [
  { value: 0, label: 'Off — always live' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 21_600, label: '6 hours' },
  { value: 86_400, label: '24 hours' },
];

export interface WizardState {
  sourceId?: string;
  type: SourceType | null;
  name: string;
  description: string;
  connection: FormValues;
  /** New secret values typed in this session. Held in memory only, never logged or persisted. */
  secrets: Record<string, string>;
  /** Secrets already stored on the server (edit mode). */
  storedSecrets: Record<string, { isSet: boolean; updatedAt?: string }>;
  /** Stored secrets the admin chose to replace. */
  replacing: Record<string, boolean>;
  test: ConnectionTestResult | null;
  testedFingerprint: string | null;
  initialFingerprint: string | null;
  discovered: DiscoveredSchema | null;
  exposed: ExposedEntity[];
  glossary: GlossaryTerm[];
  exampleQuestions: string[];
  roleIds: string[];
  rowLimit: number;
  queryTimeoutSeconds: number;
  cacheTtlSeconds: number;
}

export function initialState(detail?: AdminSourceDetail): WizardState {
  if (!detail) {
    return {
      type: null,
      name: '',
      description: '',
      connection: {},
      secrets: {},
      storedSecrets: {},
      replacing: {},
      test: null,
      testedFingerprint: null,
      initialFingerprint: null,
      discovered: null,
      exposed: [],
      glossary: [],
      exampleQuestions: [],
      roleIds: [],
      rowLimit: 500,
      queryTimeoutSeconds: 30,
      cacheTtlSeconds: 900,
    };
  }
  const state: WizardState = {
    sourceId: detail.id,
    type: detail.type,
    name: detail.name,
    description: detail.description,
    connection: fromConnectionValues(detail.type, detail.connection),
    secrets: {},
    storedSecrets: detail.secrets,
    replacing: {},
    test: null,
    testedFingerprint: null,
    initialFingerprint: null,
    discovered: null,
    exposed: detail.exposed,
    glossary: detail.glossary,
    exampleQuestions: detail.exampleQuestions,
    roleIds: detail.roleIds,
    rowLimit: detail.rowLimit,
    queryTimeoutSeconds: detail.queryTimeoutSeconds,
    cacheTtlSeconds: detail.cacheTtlSeconds,
  };
  state.initialFingerprint = connectionFingerprint(state);
  return state;
}

export function withType(state: WizardState, type: SourceType): WizardState {
  return {
    ...state,
    type,
    connection: defaultConnectionValues(type),
    secrets: {},
    test: null,
    testedFingerprint: null,
    discovered: null,
    exposed: [],
  };
}

/** Secrets that will be sent: new ones, or stored ones being replaced. */
export function secretsToSend(state: WizardState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(state.secrets)) {
    const stored = state.storedSecrets[key]?.isSet;
    if (value && (!stored || state.replacing[key])) out[key] = value;
  }
  return out;
}

export function existingSecretKeys(state: WizardState): Set<string> {
  return new Set(
    Object.entries(state.storedSecrets)
      .filter(([key, status]) => status.isSet && !state.replacing[key])
      .map(([key]) => key),
  );
}

/** Identifies the connection settings; a successful test is only valid for the exact settings tested. */
export function connectionFingerprint(state: WizardState): string {
  if (!state.type) return '';
  const secretMarker = Object.fromEntries(
    Object.entries(secretsToSend(state)).map(([key, value]) => [key, `${value.length}:${simpleHash(value)}`]),
  );
  return JSON.stringify([state.type, toConnectionValues(state.type, state.connection), secretMarker]);
}

function simpleHash(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return hash;
}

export function isTestSatisfied(state: WizardState): boolean {
  const fingerprint = connectionFingerprint(state);
  if (state.initialFingerprint && fingerprint === state.initialFingerprint) return true;
  return Boolean(state.test?.ok && state.test.readOnly && state.testedFingerprint === fingerprint);
}

export function stepErrors(step: number, state: WizardState): Record<string, string> {
  const errors: Record<string, string> = {};
  switch (step) {
    case 0:
      if (!state.type) errors.type = 'Choose the type of database.';
      break;
    case 1: {
      const name = state.name.trim();
      if (name.length < 2) errors.name = 'Give this data source a name people will recognise.';
      if (name.length > 80) errors.name = 'Keep the name under 80 characters.';
      if (state.type) {
        Object.assign(errors, validateConnection(state.type, state.connection, secretsToSend(state), existingSecretKeys(state)));
      }
      break;
    }
    case 2:
      if (!isTestSatisfied(state)) errors.test = 'Run a successful test with a read-only account to continue.';
      break;
    case 3:
      if (state.exposed.length === 0) {
        const noun = state.type ? SOURCE_TYPES[state.type].entityNoun : 'tables';
        errors.exposed = `Choose at least one of the ${noun} people can ask about.`;
      }
      break;
    case 5:
      if (state.roleIds.length === 0) errors.roleIds = 'Choose at least one role that can use this data source.';
      if (!Number.isInteger(state.rowLimit) || state.rowLimit < 1 || state.rowLimit > 100_000) {
        errors.rowLimit = 'Row limit must be between 1 and 100,000.';
      }
      if (!Number.isInteger(state.queryTimeoutSeconds) || state.queryTimeoutSeconds < 5 || state.queryTimeoutSeconds > 600) {
        errors.queryTimeoutSeconds = 'Timeout must be between 5 and 600 seconds.';
      }
      break;
  }
  return errors;
}

export function toInput(state: WizardState): SourceConfigInput {
  if (!state.type) throw new Error('Source type missing');
  return {
    name: state.name.trim(),
    type: state.type,
    description: state.description.trim(),
    connection: toConnectionValues(state.type, state.connection),
    secrets: secretsToSend(state),
    exposed: state.exposed,
    glossary: state.glossary.filter((item) => item.term.trim() && item.definition.trim()),
    exampleQuestions: state.exampleQuestions.map((item) => item.trim()).filter(Boolean),
    roleIds: state.roleIds,
    rowLimit: state.rowLimit,
    queryTimeoutSeconds: state.queryTimeoutSeconds,
    cacheTtlSeconds: state.cacheTtlSeconds,
  };
}
