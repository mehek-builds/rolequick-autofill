import React, { useEffect, useState } from 'react';
import {
  getExperienceBank,
  putExperienceBank,
  getApplicationProfile,
  putApplicationProfile,
} from '../lib/api';
import { getAutoSubmitEnabled, setAutoSubmitEnabled } from '../lib/storage';
import type { ExperienceBankEntry, ApplicationProfile, Profile } from '../lib/types';
import { parseStoredDate, formatDate } from '../lib/adapters/shared/dates';
import WarningBanner from './WarningBanner';
import LoadingSpinner from './LoadingSpinner';
import {
  PopupHeader,
  StatusDot,
  fieldClass,
  primaryButtonClass,
  secondaryButtonClass,
  textAreaClass,
} from './ui';

// An <input type="date"> renders NOTHING unless its value is ISO, so switching these fields to a
// date picker would have made every existing value vanish from the screen: "18/07/2026" and
// "Summer 2027" would both just look unset, and a student would reasonably conclude the app had
// lost their data. Reuse the filler's own parser so anything resolvable is shown as the day it
// means, and say so plainly when it is not.
function isoForDateInput(stored: string | null | undefined): string {
  const parts = parseStoredDate(stored);
  return parts ? formatDate(parts, 'ymd') : '';
}

// A saved value that exists but cannot be shown. Never silently swallow it: it is the student's
// data and the reason the field looks empty.
function unreadableStoredDate(stored: string | null | undefined): string | null {
  const raw = (stored ?? '').trim();
  return raw && !parseStoredDate(raw) ? raw : null;
}

// Onboarding for Litos v2's resume-gen + application-autofill flow (PRD-v2-resume-autofill.md
// Section 4-5). Sequenced fast-confirm-first, sensitive-last (Section 5's ordering rationale):
// Bucket 1 (auto-extracted, quick confirm) -> Bucket 2 (signal-checked, never default absence
// to "no") -> Bucket 3 (always ask, never inferred) -> links/preferences. Reachable from
// MainScreen rather than folded into v0's mandatory signup, so v0 stays fast and this stays
// opt-in until the student actually wants autofill.

type Step = 'loading' | 'experience' | 'checks' | 'required' | 'links' | 'saving' | 'done';

interface AutofillSetupScreenProps {
  token: string;
  profile: Profile;
  onBack: () => void;
}

const cardClass = 'group border-b border-gray-200 py-3';

function ResumePill() {
  return (
    <span className="flex-shrink-0 text-xs font-medium text-gray-600">From resume</span>
  );
}

function StepHeader({ title, subtitle, step, total }: { title: string; subtitle: string; step: number; total: number }) {
  return (
    <div className="animate-fade-in-up">
      <div className="mb-2 flex items-center gap-3">
        <div
          className="h-1 flex-1 overflow-hidden rounded-full bg-gray-200"
          role="progressbar"
          aria-label={`Step ${step} of ${total}`}
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={step}
        >
          <span
            className="block h-full rounded-full bg-brand-600 transition-[width]"
            style={{ width: `${(step / total) * 100}%` }}
          />
        </div>
        <span className="text-xs font-medium text-gray-600">{step} of {total}</span>
      </div>
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-gray-600">{subtitle}</p>
    </div>
  );
}

function YesNoDecline({
  value,
  onChange,
  options = ['Yes', 'No', 'Prefer not to answer'],
  labelledBy,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  options?: string[];
  labelledBy?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-labelledby={labelledBy}>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          aria-pressed={value === opt}
          className={`min-h-11 rounded-md border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${
            value === opt
              ? 'border-brand-400 bg-brand-50 text-brand-700'
              : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400 hover:bg-gray-50'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

// Seeded entries carry NO tags (R-027). This used to stamp the whole `profile.skills` array onto
// EVERY entry, which is the actual root cause of R-015's "seeded junk": a tag is supposed to say
// what THIS entry demonstrates, and copying one global array onto a Product Management internship
// and a VP of Finance role alike says nothing while poisoning everything grounded against it. The
// UI collects no per-entry tags, so seeding none is the only honest value. Entries already stored
// on the server keep whatever tags they have: handleSave passes stored tags through untouched,
// and this seed only runs when the bank is empty. Exported for the test that pins this.
export function seedExperienceBank(profile: Profile): ExperienceBankEntry[] {
  const jobs: ExperienceBankEntry[] = profile.experience.map((e) => ({
    type: 'job',
    org: e.company,
    title: e.title,
    date_range: `${e.start} - ${e.end}`,
    bullet_variants: e.description ? [e.description] : [''],
    tags: [],
  }));
  const projects: ExperienceBankEntry[] = (profile.projects ?? []).map((p) => ({
    type: 'project',
    org: p.name,
    bullet_variants: p.description ? [p.description] : [''],
    tags: [],
  }));
  return [...jobs, ...projects];
}

export default function AutofillSetupScreen({ token, profile, onBack }: AutofillSetupScreenProps) {
  const [step, setStep] = useState<Step>('loading');
  const [error, setError] = useState<string | null>(null);

  const [bank, setBank] = useState<ExperienceBankEntry[]>([]);
  const [bankIsSeeded, setBankIsSeeded] = useState(false);

  const [appProfile, setAppProfile] = useState<ApplicationProfile>({});
  const [eeo, setEeo] = useState<Record<string, string>>({});
  const [eeoExpanded, setEeoExpanded] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [existingBank, existingProfile, storedAutoSubmit] = await Promise.all([
          getExperienceBank(token),
          getApplicationProfile(token).catch(() => null),
          getAutoSubmitEnabled(),
        ]);
        if (existingBank.length > 0) {
          setBank(existingBank);
        } else {
          setBank(seedExperienceBank(profile));
          setBankIsSeeded(true);
        }
        if (existingProfile) {
          setAppProfile(existingProfile);
          setEeo((existingProfile.eeo_prefs as Record<string, string>) ?? {});
        }
        setAutoSubmit(storedAutoSubmit);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load your setup data.');
      } finally {
        setStep('experience');
      }
    })();
  }, [token, profile]);

  const updateEntry = (idx: number, patch: Partial<ExperienceBankEntry>) => {
    setBank((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  };

  const removeEntry = (idx: number) => {
    setBank((prev) => prev.filter((_, i) => i !== idx));
  };

  const addEntry = () => {
    setBank((prev) => [...prev, { type: 'project', org: '', bullet_variants: [''], tags: [] }]);
  };

  const handleSave = async () => {
    setStep('saving');
    setError(null);
    try {
      await putExperienceBank(
        token,
        bank
          .filter((e) => e.org.trim())
          .map((e) => ({ ...e, bullet_variants: e.bullet_variants.filter((b) => b.trim()) })),
      );
      await putApplicationProfile(token, {
        ...appProfile,
        eeo_prefs: Object.keys(eeo).length > 0 ? eeo : null,
      });
      await setAutoSubmitEnabled(autoSubmit);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your setup.');
      setStep('links');
    }
  };

  if (step === 'loading') {
    return (
      <div className="flex min-h-[300px] items-center justify-center">
        <LoadingSpinner size="md" />
      </div>
    );
  }

  return (
    <div className="flex min-h-full animate-fade-in flex-col bg-white">
      <PopupHeader title="Application profile" subtitle="Used for autofill" onBack={onBack} />

      <main className="flex flex-1 flex-col gap-4 px-4 py-4">
        {error && <WarningBanner message={error} variant="error" />}

        {step === 'experience' && (
          <div className="flex flex-col gap-3">
            <StepHeader
              step={1}
              total={4}
              title="Your experience"
              subtitle={
                bankIsSeeded
                  ? 'Pulled from your resume. Review each entry, edit the bullet if it needs work.'
                  : 'Add the jobs and projects Litos should draw from when tailoring a resume.'
              }
            />

            <div className="flex flex-col gap-2.5">
              {bank.map((entry, idx) => (
                <div key={idx} className={cardClass} style={{ animationDelay: `${idx * 40}ms` }}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-1 flex-col gap-1.5">
                      <div className="flex items-center gap-1.5">
                        <input
                          value={entry.org}
                          onChange={(e) => updateEntry(idx, { org: e.target.value })}
                          placeholder={entry.type === 'job' ? 'Company' : 'Project name'}
                          aria-label={entry.type === 'job' ? `Company ${idx + 1}` : `Project ${idx + 1}`}
                          className="w-full rounded-md border-0 bg-transparent px-0 text-sm font-semibold text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0"
                        />
                        {bankIsSeeded && <ResumePill />}
                      </div>
                      {entry.type === 'job' && (
                        <input
                          value={entry.title ?? ''}
                          onChange={(e) => updateEntry(idx, { title: e.target.value })}
                          placeholder="Title"
                          aria-label={`Title ${idx + 1}`}
                          className="w-full rounded-md border-0 bg-transparent px-0 text-xs text-gray-600 placeholder:text-gray-500 focus:outline-none focus:ring-0"
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeEntry(idx)}
                      className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      aria-label={`Remove ${entry.org || entry.type}`}
                    >
                      ×
                    </button>
                  </div>
                  <textarea
                    value={entry.bullet_variants[0] ?? ''}
                    onChange={(e) => updateEntry(idx, { bullet_variants: [e.target.value, ...entry.bullet_variants.slice(1)] })}
                    placeholder="What did you do here? One or two sentences."
                    aria-label={`Description ${idx + 1}`}
                    rows={2}
                    className={`${textAreaClass} mt-2 text-xs`}
                  />
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={addEntry}
              className={secondaryButtonClass}
            >
              + Add another job or project
            </button>

            <button
              type="button"
              onClick={() => setStep('checks')}
              disabled={bank.filter((e) => e.org.trim()).length === 0}
              className={`${primaryButtonClass} mt-1 w-full`}
            >
              Continue
            </button>
          </div>
        )}

        {step === 'checks' && (
          <div className="flex animate-fade-in-up flex-col gap-4">
            <StepHeader
              step={2}
              total={4}
              title="A couple quick checks"
              subtitle="These aren't always on a resume, so we ask directly rather than guess."
            />

            <div className="flex flex-col gap-1.5">
              <label htmlFor="application-city" className="text-xs font-medium text-gray-700">Current city</label>
              <input
                id="application-city"
                value={appProfile.address_city ?? ''}
                onChange={(e) => setAppProfile((p) => ({ ...p, address_city: e.target.value }))}
                placeholder="e.g. Los Angeles"
                className={fieldClass}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="application-country" className="text-xs font-medium text-gray-700">Country you&apos;re based in</label>
              <input
                id="application-country"
                value={appProfile.address_country ?? ''}
                onChange={(e) => setAppProfile((p) => ({ ...p, address_country: e.target.value }))}
                placeholder="e.g. United States"
                className={fieldClass}
              />
              <p className="text-xs leading-5 text-gray-600">Where you live or would work from. Separate from citizenship below.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <p id="veteran-status-label" className="text-xs font-medium text-gray-700">Veteran or military status</p>
              <YesNoDecline labelledBy="veteran-status-label" value={eeo.veteran} onChange={(v) => setEeo((p) => ({ ...p, veteran: v }))} />
            </div>

            <button
              type="button"
              onClick={() => setStep('required')}
              className={`${primaryButtonClass} mt-1 w-full`}
            >
              Continue
            </button>
          </div>
        )}

        {step === 'required' && (
          <div className="flex animate-fade-in-up flex-col gap-4">
            <StepHeader
              step={3}
              total={4}
              title="A few required fields"
              subtitle="Nearly every application asks these. Never guessed, never defaulted."
            />

            <div className="flex flex-col gap-1.5">
              <label htmlFor="application-citizenship" className="text-xs font-medium text-gray-700">Citizenship</label>
              <input
                id="application-citizenship"
                value={appProfile.citizenship ?? ''}
                onChange={(e) => setAppProfile((p) => ({ ...p, citizenship: e.target.value }))}
                placeholder="e.g. United States"
                className={fieldClass}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <p id="work-authorization-label" className="text-xs font-medium text-gray-700">Authorized to work without sponsorship?</p>
              <YesNoDecline
                labelledBy="work-authorization-label"
                value={appProfile.work_authorized === undefined ? undefined : appProfile.work_authorized ? 'Yes' : 'No'}
                onChange={(v) => setAppProfile((p) => ({ ...p, work_authorized: v === 'Yes' }))}
                options={['Yes', 'No']}
              />
              {/* Stored for your reference only. Never used to answer forms: work-authorization
                  questions are location-specific, so Litos always leaves them for you (see
                  WORK_ELIGIBILITY_QUESTION in adapters/generic.ts). Do not re-wire this into an adapter. */}
              <p className="text-xs leading-5 text-gray-600">
                Kept on your profile for reference. Applications ask this per location, so Litos
                always leaves work-authorization questions for you to answer.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <p id="sponsorship-label" className="text-xs font-medium text-gray-700">Will need sponsorship in the future?</p>
              <YesNoDecline
                labelledBy="sponsorship-label"
                value={appProfile.needs_sponsorship === undefined ? undefined : appProfile.needs_sponsorship ? 'Yes' : 'No'}
                onChange={(v) => setAppProfile((p) => ({ ...p, needs_sponsorship: v === 'Yes' }))}
                options={['Yes', 'No']}
              />
              {/* Reference only, same as work_authorized above: sponsorship questions are
                  location-specific, so Litos never answers them from this flag (see
                  WORK_ELIGIBILITY_QUESTION in adapters/generic.ts). Do not re-wire. */}
              <p className="text-xs leading-5 text-gray-600">
                Kept on your profile for reference. Sponsorship questions are asked per location,
                so Litos always leaves them for you to answer.
              </p>
            </div>

            {/*
              type="date" is the actual fix for R-014, and it is here rather than in the filler on
              purpose. A free-text box cannot say which number is the month: "03/04/2026" is 3 April
              in Dubai and 4 March in California, and nothing in the string resolves it. The filler
              spent five attempts trying to work it out at write time and the honest answer is that
              THE INFORMATION IS NOT IN THE PAGE - the only ways to get it are to guess, or to write
              a date that is not hers and watch. Both were tried; both shipped a wrong date into a
              real application.

              A date input ends the argument at the source: the browser hands back ISO
              (YYYY-MM-DD) whatever the locale shows the student, so storage has known semantics and
              the picker's order stops mattering. The old placeholder made it worse than free text -
              it said "e.g. Summer 2027", inviting a value parseStoredDate cannot resolve, which is
              a guaranteed skip.
            */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="application-start-date" className="text-xs font-medium text-gray-700">Earliest start date (optional)</label>
              <input
                id="application-start-date"
                type="date"
                value={isoForDateInput(appProfile.availability_date)}
                onChange={(e) => setAppProfile((p) => ({ ...p, availability_date: e.target.value }))}
                className={fieldClass}
              />
              {unreadableStoredDate(appProfile.availability_date) ? (
                <p className="text-xs leading-5 text-warning-700">
                  Your saved value ("{unreadableStoredDate(appProfile.availability_date)}") isn't a date we can read, so
                  forms asking when you can start are left for you. Pick a date to fix that.
                </p>
              ) : (
                <p className="text-xs leading-5 text-gray-600">When you can start. Stored as YYYY-MM-DD.</p>
              )}
            </div>

            {/*
              A separate question from the one above, and the reason it exists: "Length or
              term/length of availability (10-14 weeks)" and "When can you start?" both contain
              "availab", so one field answering both meant a duration question got answered with a
              start time ("Immediately"). Free text, not a date: "14 weeks", "3 months" and "a
              semester" are all real answers and none of them parse.
            */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="application-availability-term" className="text-xs font-medium text-gray-700">How long you are available (optional)</label>
              <input
                id="application-availability-term"
                value={appProfile.availability_term ?? ''}
                onChange={(e) => setAppProfile((p) => ({ ...p, availability_term: e.target.value }))}
                placeholder="e.g. 14 weeks"
                className={fieldClass}
              />
              <p className="text-xs leading-5 text-gray-600">Only for forms that ask how long, not when.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="application-salary" className="text-xs font-medium text-gray-700">Desired salary (optional)</label>
              <input
                id="application-salary"
                value={appProfile.desired_salary ?? ''}
                onChange={(e) => setAppProfile((p) => ({ ...p, desired_salary: e.target.value }))}
                placeholder="Leave blank to skip"
                className={fieldClass}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="application-date-of-birth" className="text-xs font-medium text-gray-700">Date of birth (optional)</label>
              <input
                id="application-date-of-birth"
                type="date"
                value={isoForDateInput(appProfile.date_of_birth)}
                onChange={(e) => setAppProfile((p) => ({ ...p, date_of_birth: e.target.value }))}
                className={fieldClass}
              />
              {unreadableStoredDate(appProfile.date_of_birth) ? (
                <p className="text-xs leading-5 text-warning-700">
                  Your saved value ("{unreadableStoredDate(appProfile.date_of_birth)}") isn't a date we can read. Pick one
                  to fix that.
                </p>
              ) : (
                <p className="text-xs leading-5 text-gray-600">Only used when a form asks, never for SSN. Stored as YYYY-MM-DD.</p>
              )}
            </div>

            <div className="border-y border-gray-200 py-3">
              <button
                type="button"
                onClick={() => setEeoExpanded((v) => !v)}
                aria-expanded={eeoExpanded}
                aria-controls="eeo-fields"
                className="flex min-h-11 w-full items-center justify-between rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <span className="text-xs font-medium text-gray-700">
                  EEO voluntary disclosures <span className="text-gray-600">(optional)</span>
                </span>
                <span className="text-gray-600" aria-hidden="true">{eeoExpanded ? '-' : '+'}</span>
              </button>
              {eeoExpanded && (
                <div id="eeo-fields" className="mt-3 flex animate-fade-in-up flex-col gap-3">
                  {(['gender', 'race', 'disability'] as const).map((field) => (
                    <div key={field} className="flex flex-col gap-1.5">
                      <label htmlFor={`eeo-${field}`} className="text-xs font-medium capitalize text-gray-700">{field}</label>
                      <input
                        id={`eeo-${field}`}
                        value={eeo[field] ?? ''}
                        onChange={(e) => setEeo((p) => ({ ...p, [field]: e.target.value }))}
                        placeholder="Leave blank to decline"
                        className={fieldClass}
                      />
                    </div>
                  ))}
                  <p className="text-xs leading-5 text-gray-600">
                    Left blank means Litos selects "Decline to Self-Identify" on every application.
                  </p>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setStep('links')}
              className={`${primaryButtonClass} mt-1 w-full`}
            >
              Continue
            </button>
          </div>
        )}

        {step === 'links' && (
          <div className="flex animate-fade-in-up flex-col gap-4">
            <StepHeader step={4} total={4} title="Links and contact" subtitle="Whatever you don't have, leave blank." />

            {(
              [
                ['phone', 'Phone'],
                ['linkedin_url', 'LinkedIn'],
                ['github_url', 'GitHub'],
                ['portfolio_url', 'Portfolio'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="flex flex-col gap-1.5">
                <label htmlFor={`profile-${key}`} className="text-xs font-medium text-gray-700">{label}</label>
                <input
                  id={`profile-${key}`}
                  value={(appProfile[key] as string) ?? ''}
                  onChange={(e) => setAppProfile((p) => ({ ...p, [key]: e.target.value }))}
                  className={fieldClass}
                />
              </div>
            ))}

            <div className="border-y border-gray-200 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-gray-700">Auto-submit after filling</p>
                  <p className="mt-1 text-xs leading-5 text-gray-600">
                    Off by default: Litos fills the form and stops so you can review before hitting
                    Submit yourself. Turn this on and Litos will submit automatically after a
                    countdown you can cancel on each application.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoSubmit}
                  aria-label="Auto-submit after filling"
                  onClick={() => setAutoSubmit((v) => !v)}
                  className={`relative mt-0.5 h-7 w-12 flex-shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${
                    autoSubmit ? 'bg-brand-600' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition-transform ${
                      autoSubmit ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={handleSave}
              className={`${primaryButtonClass} mt-1 w-full`}
            >
              Save and finish
            </button>
          </div>
        )}

        {step === 'saving' && (
          <div className="flex flex-col items-center gap-3 py-10" role="status" aria-live="polite">
            <LoadingSpinner size="md" />
            <p className="text-xs text-gray-600">Saving your setup...</p>
          </div>
        )}

        {step === 'done' && (
          <div className="flex animate-fade-in-up flex-col gap-4 py-6" role="status" aria-live="polite">
            <div>
              <p className="flex items-center gap-2 text-base font-semibold text-gray-950">
                <StatusDot tone="success" />
                You're set up
              </p>
              <p className="mt-2 text-sm leading-6 text-gray-600">
                Next application, Litos will tailor a resume and fill the form for you
                {autoSubmit ? ', then submit it after a countdown you can cancel.' : '.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onBack}
              className={`${primaryButtonClass} w-full`}
            >
              Back to Litos
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
