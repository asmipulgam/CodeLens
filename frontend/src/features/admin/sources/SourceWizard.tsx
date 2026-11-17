import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useLocation, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { adminCreateSource, adminGetSource, adminUpdateSource, loginUrl } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { AdminSourceDetail, SourceType } from '@/api/types';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Callout, PageHeader, PageLoader } from '@/components/ui/misc';
import { useSession } from '@/auth/session';
import { cn } from '@/lib/cn';
import { AccessStep, ConnectionStep, DescribeStep, ExposeStep, TestStep, TypeStep } from './WizardSteps';
import { STEPS, initialState, stepErrors, toInput, withType, type WizardState } from './wizardState';

/**
 * Saving a data source needs a recent sign-in (the server answers 401 step_up_required otherwise).
 * Re-authenticating means leaving the page, which would lose everything typed into the wizard, so
 * ask for it up front unless there is comfortably enough time left to finish.
 */
const STEP_UP_MARGIN_MS = 20 * 60_000;

function useNeedsStepUp(): boolean {
  const session = useSession();
  const [openedAt] = useState(() => Date.now());
  return Date.parse(session.recentAuthUntil) - openedAt < STEP_UP_MARGIN_MS;
}

function StepUpRequired() {
  const location = useLocation();
  const reauthenticate = () => {
    window.location.assign(loginUrl(location.pathname + location.search, { reauthenticate: true }));
  };
  return (
    <div className="space-y-6">
      <Link to="/admin/sources" className="inline-flex items-center gap-1 text-sm text-fg-secondary hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden="true" /> Data sources
      </Link>
      <div className="max-w-xl space-y-4 rounded-xl border border-line bg-surface p-6 shadow-sm">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="size-5 text-primary" aria-hidden="true" /> Confirm it's you first
        </h1>
        <p className="text-sm text-fg-secondary">
          Connecting or changing a data source gives people access to company data, so CodeLens asks you to sign in
          again before you start. You'll come straight back here.
        </p>
        <Button onClick={reauthenticate}>Sign in again</Button>
      </div>
    </div>
  );
}

export function SourceWizardPage() {
  const needsStepUp = useNeedsStepUp();
  if (needsStepUp) return <StepUpRequired />;
  return <SourceWizardLoader />;
}

function SourceWizardLoader() {
  const { sourceId } = useParams();
  const detail = useQuery({
    queryKey: qk.admin.source(sourceId ?? ''),
    queryFn: () => adminGetSource(sourceId ?? ''),
    enabled: Boolean(sourceId),
    // Re-read on every visit so the form never shows stale settings.
    staleTime: 0,
    gcTime: 0,
  });

  if (sourceId && detail.isPending) return <PageLoader label="Loading data source" />;
  if (sourceId && detail.isError) {
    return (
      <Callout tone="danger" title="Couldn't load this data source">
        {errorMessage(detail.error)}{' '}
        <Link to="/admin/sources" className="text-primary hover:underline">
          Back to data sources
        </Link>
      </Callout>
    );
  }
  return <SourceWizard key={sourceId ?? 'new'} detail={detail.data} />;
}

function SourceWizard({ detail }: { detail?: AdminSourceDetail }) {
  const editing = Boolean(detail);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [state, setState] = useState<WizardState>(() => initialState(detail));
  const [step, setStep] = useState(editing ? 1 : 0);
  const [furthest, setFurthest] = useState(editing ? STEPS.length - 1 : 0);
  const [showErrors, setShowErrors] = useState(false);
  const [dirty, setDirty] = useState(false);
  const savedRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const update = useCallback((patch: Partial<WizardState>) => {
    setState((current) => ({ ...current, ...patch }));
    setDirty(true);
  }, []);

  const errors = showErrors ? stepErrors(step, state) : {};

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !savedRef.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const save = useMutation({
    mutationFn: () => {
      const input = toInput(state);
      return detail ? adminUpdateSource(detail.id, input) : adminCreateSource(input);
    },
    onSuccess: (saved) => {
      savedRef.current = true;
      void qc.invalidateQueries({ queryKey: qk.admin.sources });
      void qc.invalidateQueries({ queryKey: qk.sources });
      void qc.invalidateQueries({ queryKey: qk.admin.cache });
      toast.success(editing ? `${saved.name} updated` : `${saved.name} connected`, {
        description: editing ? undefined : 'People with access can start asking questions now.',
      });
      navigate('/admin/sources');
    },
    onError: (error) => toast.error("Couldn't save the data source", { description: errorMessage(error) }),
  });

  const goTo = (target: number) => {
    setShowErrors(false);
    setStep(target);
    setFurthest((current) => Math.max(current, target));
  };

  const next = () => {
    if (Object.keys(stepErrors(step, state)).length > 0) {
      setShowErrors(true);
      return;
    }
    if (step === STEPS.length - 1) save.mutate();
    else goTo(step + 1);
  };

  const canJumpTo = (target: number) => {
    if (target > furthest) return false;
    for (let index = 0; index < target; index += 1) {
      if (Object.keys(stepErrors(index, state)).length > 0) return false;
    }
    return true;
  };

  const selectType = (type: SourceType) => {
    if (state.type === type) return;
    setState((current) => withType(current, type));
    setDirty(true);
    setFurthest(0);
  };

  return (
    <div className="space-y-6">
      <Link to="/admin/sources" className="inline-flex items-center gap-1 text-sm text-fg-secondary hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden="true" /> Data sources
      </Link>
      <PageHeader title={editing ? `Edit ${detail?.name}` : 'Add a data source'} />

      <ol className="flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((label, index) => {
          const done = index < step;
          const current = index === step;
          return (
            <li key={label}>
              <button
                type="button"
                onClick={() => canJumpTo(index) && goTo(index)}
                disabled={!canJumpTo(index)}
                aria-current={current ? 'step' : undefined}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-sm text-fg-secondary disabled:cursor-not-allowed disabled:opacity-60',
                  current && 'border-primary bg-primary-wash font-medium text-fg',
                  done && !current && 'text-fg',
                )}
              >
                <span
                  className={cn(
                    'grid size-5 place-items-center rounded-full border border-line text-xs',
                    current && 'border-primary bg-primary text-primary-fg',
                    done && !current && 'border-success bg-success text-white',
                  )}
                  aria-hidden="true"
                >
                  {done && !current ? <Check className="size-3" /> : index + 1}
                </span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      <section className="rounded-xl border border-line bg-surface p-5 shadow-sm" aria-labelledby="step-title">
        <h2 id="step-title" ref={headingRef} tabIndex={-1} className="mb-4 text-lg font-semibold focus:outline-none">
          {STEPS[step]}
        </h2>
        {step === 0 && <TypeStep state={state} onSelect={selectType} errors={errors} locked={editing} />}
        {step === 1 && <ConnectionStep state={state} update={update} errors={errors} />}
        {step === 2 && <TestStep state={state} update={update} errors={errors} />}
        {step === 3 && <ExposeStep state={state} update={update} errors={errors} />}
        {step === 4 && <DescribeStep state={state} update={update} errors={errors} />}
        {step === 5 && <AccessStep state={state} update={update} errors={errors} />}
      </section>

      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" onClick={() => goTo(step - 1)} disabled={step === 0 || (editing && step === 1)}>
          Back
        </Button>
        <Button onClick={next} disabled={save.isPending}>
          {step === STEPS.length - 1 ? (save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Connect data source') : 'Continue'}
        </Button>
      </div>

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
        title="Leave without saving?"
        description="Your changes to this data source will be lost."
        confirmLabel="Leave"
        destructive
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}
