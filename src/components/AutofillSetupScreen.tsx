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

// Onboarding for RoleQuick v2's resume-gen + application-autofill flow (PRD-v2-resume-autofill.md
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

const inputClass =
  'w-full rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 transition-colors focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100';

const cardClass =
  'group rounded-xl border border-gray-100 bg-white p-3.5 shadow-card transition-all duration-200 focus-within:-translate-y-0.5 focus-within:border-brand-100 focus-within:shadow-card-hover';

function ResumePill() {
  return (
    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
      From your resume
    </span>
  );
}

function StepHeader({ title, subtitle, step, total }: { title: string; subtitle: string; step: number; total: number }) {
  return (
    <div className="animate-fade-in-up">
      <div className="mb-1.5 flex items-center gap-1">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${i < step ? 'bg-brand-500' : 'bg-gray-100'}`}
          />
        ))}
      </div>
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{subtitle}</p>
    </div>
  );
}

function YesNoDecline({
  value,
  onChange,
  options = ['Yes', 'No', 'Prefer not to answer'],
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  options?: string[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            value === opt
              ? 'border-brand-400 bg-brand-50 text-brand-700'
              : 'border-gray-200 text-gray-600 hover:border-brand-200 hover:bg-brand-50/40'
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
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-gray-100 bg-white/95 px-4 py-3 backdrop-blur">
        <button
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-semibold text-gray-900">Autofill setup</span>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-4 py-4">
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
                          className="w-full rounded-md border-0 bg-transparent px-0 text-sm font-semibold text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0"
                        />
                        {bankIsSeeded && <ResumePill />}
                      </div>
                      {entry.type === 'job' && (
                        <input
                          value={entry.title ?? ''}
                          onChange={(e) => updateEntry(idx, { title: e.target.value })}
                          placeholder="Title"
                          className="w-full rounded-md border-0 bg-transparent px-0 text-xs text-gray-500 placeholder:text-gray-400 focus:outline-none focus:ring-0"
                        />
                      )}
                    </div>
                    <button
                      onClick={() => removeEntry(idx)}
                      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-gray-300 hover:bg-gray-100 hover:text-gray-500"
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                  <textarea
                    value={entry.bullet_variants[0] ?? ''}
                    onChange={(e) => updateEntry(idx, { bullet_variants: [e.target.value, ...entry.bullet_variants.slice(1)] })}
                    placeholder="What did you do here? One or two sentences."
                    rows={2}
                    className="mt-2 w-full resize-none rounded-lg border border-gray-100 bg-gray-50/60 px-2.5 py-2 text-xs text-gray-700 placeholder:text-gray-400 focus:border-brand-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
                  />
                </div>
              ))}
            </div>

            <button
              onClick={addEntry}
              className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-xs font-medium text-gray-500 transition-colors hover:border-brand-300 hover:bg-brand-50/40 hover:text-brand-600"
            >
              + Add another job or project
            </button>

            <button
              onClick={() => setStep('checks')}
              disabled={bank.filter((e) => e.org.trim()).length === 0}
              className="mt-1 w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:bg-brand-700 hover:shadow-card-hover active:scale-[0.98] disabled:opacity-60"
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
              <label className="text-xs font-medium text-gray-600">Current city</label>
              <input
                value={appProfile.address_city ?? ''}
                onChange={(e) => setAppProfile((p) => ({ ...p, address_city: e.target.value }))}
                placeholder="e.g. Los Angeles"
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-600">Country you&apos;re based in</label>
              <input
                value={appProfile.address_country ?? ''}
                onChange={(e) => setAppProfile((p) => ({ ...p, address_country: e.target.value }))}
                placeholder="e.g. United States"
                className={inputClass}
              />
              <p className="text-[11px] text-gray-400">Where you live / would work from. Separate from citizenship below.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-600">Veteran / military status</label>
              <YesNoDecline value={eeo.veteran} onChange={(v) => setEeo((p) => ({ ...p, veteran: v }))} />
            </div>

            <button
              onClick={() => setStep('required')}
              className="mt-1 w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:bg-brand-700 hover:shadow-card-hover active:scale-[0.98]"
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
              <label className="text-xs font-medium text-gray-600">Citizenship</label>
              <input
                value={appProfile.citizenship ?? ''}
                onChange={(e) => setAppProfile((p) => ({ ...p, citizenship: e.target.value }))}
                placeholder="e.g. United States"
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-600">Authorized to work without sponsorship?</label>
              <YesNoDecline
                value={appProfile.work_authorized === undefined ? undefined : appProfile.work_authorized ? 'Yes' : 'No'}
                onChange={(v) => setAppProfile((p) => ({ ...p, work_authorized: v === 'Yes' }))}
                options={['Yes', 'No']}
              />
              {/* Stored for your reference only. Never used to answer forms: work-authorization
                  questions are location-specific, so Litos always leaves them for you (see
                  WORK_ELIGIBILITY_QUESTION in adapters/generic.ts). Do not re-wire this into an adapter. */}
              <p className="text-[11px] leading-snug text-gray-400">
                Kept on your profile for reference. Applications ask this per location, so Litos
                always leaves work-authorization questions for you to answer.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-600">Will need sponsorship in the future?</label>
              <YesNoDecline
                value={appProfile.needs_sponsorship === undefined ? undefined : appProfile.needs_sponsorship ? 'Yes' : 'No'}
                onChange={(v) => setAppProfile((p) => ({ ...p, needs_sponsorship: v === 'Yes' }))}
                options={['Yes', 'No']}
              />
              {/* Reference only, same as work_authorized above: sponsorship questions are
                  location-specific, so Litos never answers them from this flag (see
                  WORK_ELIGIBILITY_QUESTION in adapters/generic.ts). Do not re-wire. */}
              <p className="text-[11px] leading-snug text-gray-400">
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
              <label className="text-xs font-medium text-gray-600">Earliest start date (optional)</label>
              <input
                type="date"
                value={isoForDateInput(appProfile.availability_date)}
                onChange={(e) => setAppProfile((p) => ({ ...p, availability_date: e.target.value }))}
                className={inputClass}
              />
              {unreadableStoredDate(appProfile.availability_date) ? (
                <p className="text-[11px] text-amber-600">
                  Your saved value ("{unreadableStoredDate(appProfile.availability_date)}") isn't a date we can read, so
                  forms asking when you can start are left for you. Pick a date to fix that.
                </p>
              ) : (
                <p className="text-[11px] text-gray-400">When you can start. Stored as YYYY-MM-DD.</p>
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
              <label className="text-xs font-medium text-gray-600">How long you are available (optional)</label>
              <input
                value={appProfile.availability_term ?? ''}
                onChange={(e) => setAppProfile((p) => ({ ...p, availability_term: e.target.value }))}
                placeholder="e.g. 14 weeks"
                className={inputClass}
              />
              <p className="text-[11px] text-gray-400">Only for forms that ask how long, not when.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-600">Desired salary (optional)</label>
              <input
                value={appProfile.desired_salary ?? ''}
                onChange={(e) => setAppProfile((p) => ({ ...p, desired_salary: e.target.value }))}
                placeholder="Leave blank to skip"
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-600">Date of birth (optional)</label>
              <input
                type="date"
                value={isoForDateInput(appProfile.date_of_birth)}
                onChange={(e) => setAppProfile((p) => ({ ...p, date_of_birth: e.target.value }))}
                className={inputClass}
              />
              {unreadableStoredDate(appProfile.date_of_birth) ? (
                <p className="text-[11px] text-amber-600">
                  Your saved value ("{unreadableStoredDate(appProfile.date_of_birth)}") isn't a date we can read. Pick one
                  to fix that.
                </p>
              ) : (
                <p className="text-[11px] text-gray-400">Only used when a form asks, never for SSN. Stored as YYYY-MM-DD.</p>
              )}
            </div>

            <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-3">
              <button
                type="button"
                onClick={() => setEeoExpanded((v) => !v)}
                className="flex w-full items-center justify-between text-left"
              >
                <span className="text-xs font-medium text-gray-600">
                  EEO voluntary disclosures <span className="text-gray-400">(optional, skip by default)</span>
                </span>
                <span className="text-gray-400">{eeoExpanded ? '-' : '+'}</span>
              </button>
              {eeoExpanded && (
                <div className="mt-3 flex animate-fade-in-up flex-col gap-3">
                  {(['gender', 'race', 'disability'] as const).map((field) => (
                    <div key={field} className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium capitalize text-gray-600">{field}</label>
                      <input
                        value={eeo[field] ?? ''}
                        onChange={(e) => setEeo((p) => ({ ...p, [field]: e.target.value }))}
                        placeholder="Leave blank to decline"
                        className={inputClass}
                      />
                    </div>
                  ))}
                  <p className="text-[11px] text-gray-400">
                    Left blank = Litos selects "Decline to Self-Identify" on every application.
                  </p>
                </div>
              )}
            </div>

            <button
              onClick={() => setStep('links')}
              className="mt-1 w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:bg-brand-700 hover:shadow-card-hover active:scale-[0.98]"
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
                <label className="text-xs font-medium text-gray-600">{label}</label>
                <input
                  value={(appProfile[key] as string) ?? ''}
                  onChange={(e) => setAppProfile((p) => ({ ...p, [key]: e.target.value }))}
                  className={inputClass}
                />
              </div>
            ))}

            <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-3">
              <label className="flex items-start justify-between gap-3">
                <span>
                  <span className="block text-xs font-medium text-gray-700">Auto-submit after filling</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-gray-400">
                    Off by default: Litos fills the form and stops so you can review before hitting
                    Submit yourself. Turn this on and Litos will submit automatically after a
                    countdown you can cancel on each application.
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoSubmit}
                  onClick={() => setAutoSubmit((v) => !v)}
                  className={`relative mt-0.5 h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
                    autoSubmit ? 'bg-brand-600' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                      autoSubmit ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </label>
            </div>

            <button
              onClick={handleSave}
              className="mt-1 w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:bg-brand-700 hover:shadow-card-hover active:scale-[0.98]"
            >
              Save and finish
            </button>
          </div>
        )}

        {step === 'saving' && (
          <div className="flex flex-col items-center gap-3 py-10">
            <LoadingSpinner size="md" />
            <p className="text-xs text-gray-400">Saving your setup...</p>
          </div>
        )}

        {step === 'done' && (
          <div className="flex animate-pop-in flex-col items-center gap-3 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-50">
              <svg className="h-6 w-6 animate-check-pop text-green-500" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">You're set up</p>
              <p className="mt-0.5 text-xs text-gray-400">
                Next application, Litos will tailor a resume and fill the form for you
                {autoSubmit ? ', then submit it after a countdown you can cancel.' : '.'}
              </p>
            </div>
            <button
              onClick={onBack}
              className="mt-2 rounded-lg bg-brand-600 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-700"
            >
              Back to Litos
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
