import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Loader2, Plus, ScanSearch, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '@/api/client';
import { adminDiscoverSchema, adminListRoles, adminTestConnection } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { EntityKind, ExposedEntity, SourceType } from '@/api/types';
import { SOURCE_TYPE_LABELS, SourceTypeIcon } from '@/components/SourceBits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldError, Input, Label, Select, Textarea } from '@/components/ui/input';
import { Callout, Skeleton } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/cn';
import { formatDate, formatNumber, formatSecondsShort } from '@/lib/format';
import { SENSITIVE_FIELD, SOURCE_TYPES, isFieldVisible, toConnectionValues } from './connectionFields';
import {
  CACHE_TTL_OPTIONS,
  connectionFingerprint,
  isTestSatisfied,
  secretsToSend,
  type WizardState,
} from './wizardState';

interface StepProps {
  state: WizardState;
  update: (patch: Partial<WizardState>) => void;
  errors: Record<string, string>;
}

/* ───────────── Step 1: type ───────────── */

export function TypeStep({ state, onSelect, errors, locked }: { state: WizardState; onSelect: (type: SourceType) => void; errors: Record<string, string>; locked: boolean }) {
  const types = Object.keys(SOURCE_TYPES) as SourceType[];
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm text-fg-secondary">
        {locked ? 'The database type cannot be changed after a data source is created.' : 'What kind of database are you connecting?'}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Database type">
        {types.map((type) => {
          const selected = state.type === type;
          return (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={locked && !selected}
              onClick={() => onSelect(type)}
              className={cn(
                'flex items-start gap-3 rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-50',
                selected && 'border-primary bg-primary-wash',
              )}
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-wash">
                <SourceTypeIcon type={type} className="size-5" />
              </span>
              <span>
                <span className="block font-medium">{SOURCE_TYPES[type].label}</span>
                <span className="block text-xs text-fg-secondary">{SOURCE_TYPES[type].description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <FieldError>{errors.type}</FieldError>
    </fieldset>
  );
}

/* ───────────── Step 2: connection ───────────── */

export function ConnectionStep({ state, update, errors }: StepProps) {
  if (!state.type) return null;
  const def = SOURCE_TYPES[state.type];
  const setValue = (key: string, value: string | boolean) => update({ connection: { ...state.connection, [key]: value } });
  const setSecret = (key: string, value: string) => update({ secrets: { ...state.secrets, [key]: value } });

  return (
    <div className="space-y-6">
      <Callout tone="warning" title="Use a read-only database account">
        CodeLens only reads data, but the database account is your last line of defence. Create an account that can
        only <strong>read</strong> the tables you plan to expose. Credentials are encrypted in the server's vault and
        are never shown again.
      </Callout>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="source-name" label="Display name" required error={errors.name} hint="Shown to everyone, e.g. “Sales Database”.">
          <Input
            id="source-name"
            value={state.name}
            maxLength={80}
            onChange={(event) => update({ name: event.target.value })}
            aria-invalid={Boolean(errors.name)}
          />
        </Field>
        <Field id="source-description" label="Description" hint="In plain English: what's in it and who uses it.">
          <Input
            id="source-description"
            value={state.description}
            maxLength={300}
            onChange={(event) => update({ description: event.target.value })}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {def.fields
          .filter((field) => isFieldVisible(field, state.connection))
          .map((field) => {
            const id = `conn-${field.key}`;
            const error = errors[field.key];

            if (field.secret) {
              const stored = state.storedSecrets[field.key];
              if (stored?.isSet && !state.replacing[field.key]) {
                return (
                  <div key={field.key} className="space-y-1.5">
                    <Label>{field.label}</Label>
                    <div className="flex h-9 items-center gap-2 rounded-md border border-line bg-wash px-3 text-sm">
                      <KeyRound className="size-4 text-success" aria-hidden="true" />
                      <span className="flex-1 text-fg-secondary">
                        Set{stored.updatedAt ? ` · last changed ${formatDate(stored.updatedAt)}` : ''}
                      </span>
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => update({ replacing: { ...state.replacing, [field.key]: true } })}
                      >
                        Replace
                      </Button>
                    </div>
                  </div>
                );
              }
              return (
                <Field key={field.key} id={id} label={field.label} required={field.required} error={error} hint={field.help} className={field.kind === 'secret-textarea' ? 'sm:col-span-2' : undefined}>
                  {field.kind === 'secret-textarea' ? (
                    <Textarea
                      id={id}
                      value={state.secrets[field.key] ?? ''}
                      onChange={(event) => setSecret(field.key, event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono text-xs"
                      placeholder="-----BEGIN PRIVATE KEY-----"
                      aria-invalid={Boolean(error)}
                    />
                  ) : (
                    <Input
                      id={id}
                      type="password"
                      value={state.secrets[field.key] ?? ''}
                      onChange={(event) => setSecret(field.key, event.target.value)}
                      autoComplete="new-password"
                      spellCheck={false}
                      aria-invalid={Boolean(error)}
                    />
                  )}
                  {stored?.isSet && (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => {
                        const { [field.key]: _removed, ...rest } = state.secrets;
                        update({ secrets: rest, replacing: { ...state.replacing, [field.key]: false } });
                      }}
                    >
                      Keep the current value
                    </Button>
                  )}
                </Field>
              );
            }

            if (field.kind === 'checkbox') {
              return (
                <div key={field.key} className="flex items-center gap-2 self-end pb-2">
                  <Checkbox
                    id={id}
                    checked={state.connection[field.key] === true}
                    onCheckedChange={(checked) => setValue(field.key, checked === true)}
                  />
                  <Label htmlFor={id}>{field.label}</Label>
                </div>
              );
            }

            if (field.kind === 'select') {
              return (
                <Field key={field.key} id={id} label={field.label} hint={field.help} error={error}>
                  <Select
                    id={id}
                    value={String(state.connection[field.key] ?? '')}
                    onChange={(event) => setValue(field.key, event.target.value)}
                  >
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            }

            return (
              <Field key={field.key} id={id} label={field.label} required={field.required} hint={field.help} error={error}>
                <Input
                  id={id}
                  inputMode={field.kind === 'number' ? 'numeric' : undefined}
                  value={String(state.connection[field.key] ?? '')}
                  placeholder={field.placeholder}
                  onChange={(event) => setValue(field.key, event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(error)}
                />
              </Field>
            );
          })}
      </div>
    </div>
  );
}

/* ───────────── Step 3: test ───────────── */

export function TestStep({ state, update, errors }: StepProps) {
  const fingerprint = connectionFingerprint(state);
  const unchangedEdit = Boolean(state.initialFingerprint && state.initialFingerprint === fingerprint);
  const test = useMutation({
    mutationFn: () =>
      adminTestConnection({
        sourceId: state.sourceId,
        type: state.type!,
        connection: toConnectionValues(state.type!, state.connection),
        secrets: secretsToSend(state),
      }),
    onSuccess: (result) => update({ test: result, testedFingerprint: fingerprint }),
    onError: (error) =>
      update({
        test: { ok: false, readOnly: false, message: errorMessage(error), warnings: [] },
        testedFingerprint: fingerprint,
      }),
  });

  const result = state.testedFingerprint === fingerprint ? state.test : null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-secondary">
        CodeLens will connect with these settings, check the account can't change data, and disconnect.
      </p>
      {unchangedEdit && !result && (
        <Callout tone="info">The connection settings haven't changed, so you can skip this step or test again.</Callout>
      )}
      <Button onClick={() => test.mutate()} disabled={test.isPending}>
        {test.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ScanSearch aria-hidden="true" />}
        {test.isPending ? 'Testing…' : 'Test connection'}
      </Button>

      {result && (
        <div className="space-y-3" aria-live="polite">
          {result.ok ? (
            <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success-wash p-3 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--status-good)' }} aria-hidden="true" />
              <div>
                <p className="font-medium">Connected{result.latencyMs !== undefined ? ` in ${result.latencyMs} ms` : ''}</p>
                <p className="text-fg-secondary">
                  {result.serverVersion ? `${result.serverVersion}. ` : ''}
                  {result.message}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-wash p-3 text-sm" role="alert">
              <XCircle className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--status-critical)' }} aria-hidden="true" />
              <div>
                <p className="font-medium">Couldn't connect</p>
                <p className="text-fg-secondary">{result.message}</p>
              </div>
            </div>
          )}
          {result.ok && !result.readOnly && (
            <Callout tone="danger" title="This account can change data">
              For safety, CodeLens only accepts accounts that can read but not write. Ask your database administrator for a
              read-only account, update the connection, and test again.
            </Callout>
          )}
          {result.ok && result.readOnly && (
            <p className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="size-4" style={{ color: 'var(--status-good)' }} aria-hidden="true" /> Account is
              read-only.
            </p>
          )}
          {result.warnings.map((warning) => (
            <Callout key={warning} tone="warning">
              {warning}
            </Callout>
          ))}
        </div>
      )}
      {!isTestSatisfied(state) && <FieldError>{errors.test}</FieldError>}
    </div>
  );
}

/* ───────────── Step 4: choose data ───────────── */

interface TreeEntity {
  namespace: string;
  name: string;
  kind: EntityKind;
  fields: { name: string; type: string }[];
}

function entityKey(entity: { namespace: string; name: string }) {
  return `${entity.namespace}\u0000${entity.name}`;
}

export function ExposeStep({ state, update, errors }: StepProps) {
  const [customPattern, setCustomPattern] = useState('');
  const discover = useMutation({
    mutationFn: () =>
      adminDiscoverSchema({
        sourceId: state.sourceId,
        type: state.type!,
        connection: toConnectionValues(state.type!, state.connection),
        secrets: secretsToSend(state),
      }),
    onSuccess: (schema) => update({ discovered: schema }),
  });

  const { mutate: runDiscover } = discover;
  const shouldDiscover = !state.discovered;
  useEffect(() => {
    if (shouldDiscover) runDiscover();
  }, [shouldDiscover, runDiscover]);

  const exposedByKey = useMemo(() => new Map(state.exposed.map((entity) => [entityKey(entity), entity])), [state.exposed]);

  const tree = useMemo(() => {
    const groups = new Map<string, TreeEntity[]>();
    for (const namespace of state.discovered?.namespaces ?? []) {
      groups.set(
        namespace.name,
        namespace.entities.map((entity) => ({ namespace: namespace.name, ...entity })),
      );
    }
    for (const entity of state.exposed) {
      const list = groups.get(entity.namespace) ?? [];
      if (!list.some((item) => item.name === entity.name)) {
        list.push({ namespace: entity.namespace, name: entity.name, kind: entity.kind, fields: entity.fields });
        groups.set(entity.namespace, list);
      }
    }
    return [...groups.entries()];
  }, [state.discovered, state.exposed]);

  const toExposed = (entity: TreeEntity): ExposedEntity =>
    exposedByKey.get(entityKey(entity)) ?? {
      namespace: entity.namespace,
      name: entity.name,
      kind: entity.kind,
      description: '',
      fields: entity.fields.map((field) => ({
        name: field.name,
        type: field.type,
        description: '',
        masked: SENSITIVE_FIELD.test(field.name),
      })),
    };

  const setSelected = (entities: TreeEntity[], selected: boolean) => {
    const keys = new Set(entities.map(entityKey));
    const rest = state.exposed.filter((entity) => !keys.has(entityKey(entity)));
    update({ exposed: selected ? [...rest, ...entities.map(toExposed)] : rest });
  };

  const addPattern = () => {
    const pattern = customPattern.trim();
    if (!pattern) return;
    setSelected([{ namespace: 'custom', name: pattern, kind: 'keyPattern', fields: [] }], true);
    setCustomPattern('');
  };

  const noun = state.type ? SOURCE_TYPES[state.type].entityNoun : 'tables';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-secondary">
          Choose the {noun} people may ask about. Everything else stays invisible to CodeLens.
        </p>
        <Button variant="outline" size="sm" onClick={() => discover.mutate()} disabled={discover.isPending}>
          <ScanSearch aria-hidden="true" /> {discover.isPending ? 'Scanning…' : 'Scan again'}
        </Button>
      </div>

      {discover.isError && (
        <Callout tone="danger" title="Couldn't read the database structure">
          {errorMessage(discover.error)}
        </Callout>
      )}
      {discover.isPending && !state.discovered && <Skeleton className="h-48" />}

      <div className="space-y-3">
        {tree.map(([namespace, entities]) => {
          const selectedCount = entities.filter((entity) => exposedByKey.has(entityKey(entity))).length;
          const all = selectedCount === entities.length && entities.length > 0;
          const some = selectedCount > 0 && !all;
          const groupId = `ns-${namespace}`;
          return (
            <div key={namespace} className="rounded-xl border border-line bg-surface">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <Checkbox
                  id={groupId}
                  checked={all ? true : some ? 'indeterminate' : false}
                  onCheckedChange={() => setSelected(entities, !all)}
                />
                <Label htmlFor={groupId} className="font-mono text-xs">
                  {namespace}
                </Label>
                <span className="ml-auto text-xs text-fg-secondary">
                  {selectedCount} of {entities.length} selected
                </span>
              </div>
              <ul className="grid gap-1 p-2 sm:grid-cols-2">
                {entities.map((entity) => {
                  const id = `entity-${namespace}-${entity.name}`;
                  const exposed = exposedByKey.get(entityKey(entity));
                  const hiddenCount = exposed?.fields.filter((field) => field.masked).length ?? 0;
                  return (
                    <li key={entity.name}>
                      <label htmlFor={id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-wash">
                        <Checkbox
                          id={id}
                          checked={Boolean(exposed)}
                          onCheckedChange={(checked) => setSelected([entity], checked === true)}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{entity.name}</span>
                        {entity.fields.length > 0 && (
                          <span className="text-xs text-fg-secondary">{entity.fields.length} fields</span>
                        )}
                        {hiddenCount > 0 && (
                          <Badge tone="warning" title="Fields that look sensitive were pre-marked as hidden">
                            {hiddenCount} hidden
                          </Badge>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      {state.type === 'redis' && (
        <div className="flex items-end gap-2">
          <Field id="custom-pattern" label="Add a key pattern" hint="For example: session:* or stats:daily:*" className="flex-1">
            <Input
              id="custom-pattern"
              value={customPattern}
              onChange={(event) => setCustomPattern(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addPattern();
                }
              }}
              className="font-mono"
            />
          </Field>
          <Button variant="outline" onClick={addPattern} className="mb-5">
            <Plus aria-hidden="true" /> Add
          </Button>
        </div>
      )}
      <FieldError>{errors.exposed}</FieldError>
    </div>
  );
}

/* ───────────── Step 5: describe ───────────── */

export function DescribeStep({ state, update }: StepProps) {
  const setEntity = (index: number, patch: Partial<ExposedEntity>) =>
    update({ exposed: state.exposed.map((entity, i) => (i === index ? { ...entity, ...patch } : entity)) });

  return (
    <div className="space-y-6">
      <Callout tone="info" title="Good descriptions mean better answers">
        CodeLens uses these descriptions to understand questions. Write them the way your colleagues talk. Fields that
        look sensitive (emails, phone numbers, salaries…) were pre-marked as hidden — please review them.
      </Callout>

      <div className="space-y-4">
        {state.exposed.map((entity, index) => (
          <details key={`${entity.namespace}.${entity.name}`} className="group rounded-xl border border-line bg-surface" open={index === 0}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <span className="font-mono text-sm">
                {entity.namespace}.{entity.name}
              </span>
              <span className="ml-auto flex items-center gap-2 text-xs text-fg-secondary">
                {entity.fields.filter((field) => field.masked).length > 0 && (
                  <Badge tone="warning">{entity.fields.filter((field) => field.masked).length} hidden</Badge>
                )}
                {entity.description ? 'Described' : 'Needs a description'}
              </span>
            </summary>
            <div className="space-y-4 border-t border-line p-4">
              <Field id={`desc-${index}`} label="What is this?">
                <Textarea
                  id={`desc-${index}`}
                  value={entity.description}
                  maxLength={500}
                  placeholder="e.g. One row per customer order, including totals and region."
                  onChange={(event) => setEntity(index, { description: event.target.value })}
                />
              </Field>
              {entity.fields.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Fields in {entity.name}</caption>
                    <thead>
                      <tr className="text-left text-xs text-fg-secondary">
                        <th scope="col" className="pb-2 pr-3 font-medium">
                          Field
                        </th>
                        <th scope="col" className="pb-2 pr-3 font-medium">
                          Meaning (optional)
                        </th>
                        <th scope="col" className="pb-2 font-medium">
                          Hide values
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {entity.fields.map((field, fieldIndex) => (
                        <tr key={field.name} className="border-t border-line/70">
                          <td className="py-1.5 pr-3">
                            <span className="font-mono text-xs">{field.name}</span>
                            <span className="ml-2 text-xs text-fg-secondary">{field.type}</span>
                          </td>
                          <td className="py-1.5 pr-3">
                            <Input
                              value={field.description}
                              maxLength={200}
                              aria-label={`Meaning of ${field.name}`}
                              className="h-8"
                              onChange={(event) =>
                                setEntity(index, {
                                  fields: entity.fields.map((item, i) =>
                                    i === fieldIndex ? { ...item, description: event.target.value } : item,
                                  ),
                                })
                              }
                            />
                          </td>
                          <td className="py-1.5">
                            <Switch
                              checked={field.masked}
                              aria-label={`Hide values of ${field.name}`}
                              onCheckedChange={(checked) =>
                                setEntity(index, {
                                  fields: entity.fields.map((item, i) => (i === fieldIndex ? { ...item, masked: checked } : item)),
                                })
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </details>
        ))}
      </div>

      <ListEditor
        title="Business glossary"
        description="Define terms people use, so CodeLens interprets them the same way your team does."
        items={state.glossary}
        empty={{ term: '', definition: '' }}
        onChange={(glossary) => update({ glossary })}
        render={(item, onChange) => (
          <div className="grid flex-1 gap-2 sm:grid-cols-[12rem_1fr]">
            <Input value={item.term} placeholder="Term, e.g. Active customer" aria-label="Term" maxLength={60} onChange={(e) => onChange({ ...item, term: e.target.value })} />
            <Input
              value={item.definition}
              placeholder="Definition, e.g. Placed an order in the last 90 days"
              aria-label="Definition"
              maxLength={300}
              onChange={(e) => onChange({ ...item, definition: e.target.value })}
            />
          </div>
        )}
      />

      <ListEditor
        title="Example questions"
        description="Shown to people on the welcome screen and in “What can I ask?”."
        items={state.exampleQuestions}
        empty=""
        onChange={(exampleQuestions) => update({ exampleQuestions })}
        render={(item, onChange) => (
          <Input value={item} placeholder="e.g. What were total sales by region last month?" aria-label="Example question" maxLength={200} onChange={(e) => onChange(e.target.value)} />
        )}
      />
    </div>
  );
}

function ListEditor<T>({
  title,
  description,
  items,
  empty,
  onChange,
  render,
}: {
  title: string;
  description: string;
  items: T[];
  empty: T;
  onChange: (items: T[]) => void;
  render: (item: T, onChange: (item: T) => void) => ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-sm text-fg-secondary">{description}</p>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={index} className="flex items-start gap-2">
            {render(item, (next) => onChange(items.map((current, i) => (i === index ? next : current))))}
            <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => onChange(items.filter((_, i) => i !== index))}>
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" onClick={() => onChange([...items, empty])}>
        <Plus aria-hidden="true" /> Add
      </Button>
    </section>
  );
}

/* ───────────── Step 6: access & cache ───────────── */

export function AccessStep({ state, update, errors }: StepProps) {
  const roles = useQuery({ queryKey: qk.admin.roles, queryFn: adminListRoles });
  const hidden = state.exposed.reduce((sum, entity) => sum + entity.fields.filter((field) => field.masked).length, 0);

  return (
    <div className="space-y-6">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Who can ask about this data?</legend>
        {roles.isPending ? (
          <Skeleton className="h-24" />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {roles.data?.map((role) => {
              const id = `role-${role.id}`;
              const checked = state.roleIds.includes(role.id);
              return (
                <label key={role.id} htmlFor={id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3 hover:bg-wash">
                  <Checkbox
                    id={id}
                    className="mt-0.5"
                    checked={checked}
                    onCheckedChange={() =>
                      update({ roleIds: checked ? state.roleIds.filter((item) => item !== role.id) : [...state.roleIds, role.id] })
                    }
                  />
                  <span>
                    <span className="block text-sm font-medium">{role.name}</span>
                    <span className="block text-xs text-fg-secondary">
                      {role.description} · {role.memberCount} people
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <FieldError>{errors.roleIds}</FieldError>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="row-limit" label="Max rows per answer" error={errors.rowLimit} hint="Larger results are cut off.">
          <Input
            id="row-limit"
            inputMode="numeric"
            value={String(state.rowLimit)}
            onChange={(event) => update({ rowLimit: Number(event.target.value.replace(/\D/g, '')) || 0 })}
          />
        </Field>
        <Field id="timeout" label="Query timeout (seconds)" error={errors.queryTimeoutSeconds}>
          <Input
            id="timeout"
            inputMode="numeric"
            value={String(state.queryTimeoutSeconds)}
            onChange={(event) => update({ queryTimeoutSeconds: Number(event.target.value.replace(/\D/g, '')) || 0 })}
          />
        </Field>
        <Field id="cache-ttl" label="Reuse answers for" hint="Shorter for data that changes often.">
          <Select id="cache-ttl" value={state.cacheTtlSeconds} onChange={(event) => update({ cacheTtlSeconds: Number(event.target.value) })}>
            {CACHE_TTL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <section className="rounded-xl border border-line bg-wash/60 p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert className="size-4 text-primary" aria-hidden="true" /> Review
        </h3>
        <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-fg-secondary">Name</dt>
          <dd>{state.name || '—'}</dd>
          <dt className="text-fg-secondary">Type</dt>
          <dd>{state.type ? SOURCE_TYPE_LABELS[state.type] : '—'}</dd>
          <dt className="text-fg-secondary">Exposed</dt>
          <dd>
            {formatNumber(state.exposed.length)} {state.type ? SOURCE_TYPES[state.type].entityNoun : 'tables'}
          </dd>
          <dt className="text-fg-secondary">Hidden fields</dt>
          <dd>{formatNumber(hidden)}</dd>
          <dt className="text-fg-secondary">Roles with access</dt>
          <dd>{roles.data?.filter((role) => state.roleIds.includes(role.id)).map((role) => role.name).join(', ') || '—'}</dd>
          <dt className="text-fg-secondary">Answer reuse</dt>
          <dd>{formatSecondsShort(state.cacheTtlSeconds)}</dd>
        </dl>
      </section>
    </div>
  );
}
