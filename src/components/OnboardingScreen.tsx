import React, { useState, useRef } from 'react';
import { createSession, uploadProfile } from '../lib/api';
import { setToken, setProfile } from '../lib/storage';
import type { Profile } from '../lib/types';
import WarningBanner from './WarningBanner';

interface OnboardingScreenProps {
  onComplete: (profile: Profile, token: string) => void;
}

export default function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  const [email, setEmail] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'form' | 'uploading'>('form');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.type !== 'application/pdf') {
      setError('Please upload a PDF file.');
      return;
    }
    setError(null);
    setFile(f);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) { setError('Please enter your email.'); return; }
    if (!file) { setError('Please upload your resume (PDF).'); return; }

    setError(null);
    setLoading(true);
    setStep('uploading');

    try {
      const { token } = await createSession(email.trim());
      await setToken(token);

      const profile = await uploadProfile(token, file);
      await setProfile(profile);

      onComplete(profile, token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Is the backend running?');
      setStep('form');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full animate-fade-in flex-col">
      {/* Header with a soft brand gradient */}
      <div className="bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-6 text-center">
        <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-lg font-bold text-white backdrop-blur">
          V
        </div>
        <h1 className="text-xl font-bold tracking-tight text-white">Volley</h1>
        <p className="mt-1 text-xs text-brand-100">
          Skip the volume game. Reach the right human.
        </p>
      </div>

      <div className="flex-1 px-4 py-6">
        {loading ? (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="relative h-12 w-12">
              <div className="absolute inset-0 rounded-full border-[3px] border-brand-100" />
              <div className="absolute inset-0 animate-spin rounded-full border-[3px] border-transparent border-t-brand-600" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-gray-700">Reading your resume...</p>
              <p className="mt-0.5 text-xs text-gray-400">
                Pulling out your experience so drafts sound like you.
              </p>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Let's set you up</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-500">
                Two quick things, then Volley personalizes every message from your real
                background.
              </p>
            </div>

            {error && <WarningBanner message={error} variant="error" />}

            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-700">
                  1
                </span>
                Email address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@university.edu"
                className="w-full rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm transition-colors focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-700">
                  2
                </span>
                Your resume
              </label>
              <div
                onClick={() => fileRef.current?.click()}
                className={`cursor-pointer rounded-xl border-2 border-dashed px-4 py-5 text-center transition-all duration-200 ${
                  file
                    ? 'border-brand-400 bg-brand-50'
                    : 'border-gray-200 hover:border-brand-300 hover:bg-gray-50/60'
                }`}
              >
                {file ? (
                  <div className="flex animate-pop-in flex-col items-center gap-1">
                    <svg className="h-6 w-6 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="max-w-full truncate text-xs font-medium text-brand-700">{file.name}</span>
                    <span className="text-[11px] text-gray-400">Tap to change</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-1">
                    <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    <span className="text-xs text-gray-500">Drop in your resume</span>
                    <span className="text-[11px] text-gray-400">PDF only</span>
                  </div>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-150 hover:bg-brand-700 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
            >
              Get started
            </button>

            <p className="text-center text-[11px] leading-relaxed text-gray-400">
              Your resume stays private and is only used to personalize your own drafts.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
