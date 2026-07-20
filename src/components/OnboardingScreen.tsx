import React, { useState, useRef } from 'react';
import { createSession, requestCode, verifyCode, uploadProfile } from '../lib/api';
import { setToken, setProfile } from '../lib/storage';
import type { Profile } from '../lib/types';
import WarningBanner from './WarningBanner';
import BrandMark from './BrandMark';

interface OnboardingScreenProps {
  onComplete: (profile: Profile, token: string) => void;
}

export default function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  const [email, setEmail] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'form' | 'code' | 'uploading'>('form');
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

  // Shared tail of signup: store token, parse resume, hand off to the app.
  const finishSignup = async (token: string) => {
    setStep('uploading');
    await setToken(token);
    const profile = await uploadProfile(token, file!);
    await setProfile(profile);
    onComplete(profile, token);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) { setError('Please enter your email.'); return; }
    if (!file) { setError('Please upload your resume (PDF).'); return; }

    setError(null);
    setLoading(true);

    try {
      // Verified signup: email a 6-digit code, then collect it.
      await requestCode(email.trim());
      setCode('');
      setStep('code');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('503') || msg.includes('verification_unavailable')) {
        // Email sending not configured on the backend yet: legacy passwordless path.
        try {
          const { token } = await createSession(email.trim());
          await finishSignup(token);
          return;
        } catch (e2) {
          setError(e2 instanceof Error ? e2.message : 'Something went wrong. Is the backend running?');
          setStep('form');
        }
      } else {
        setError(msg || 'Could not send the verification code.');
        setStep('form');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) { setError('Enter the 6-digit code from your email.'); return; }

    setError(null);
    setLoading(true);

    try {
      const { token } = await verifyCode(email.trim(), code.trim());
      await finishSignup(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verification failed.';
      setError(msg.includes('Incorrect') || msg.includes('400') ? 'That code is not right. Check your email and try again.' : msg);
      setStep('code');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError(null);
    setLoading(true);
    try {
      await requestCode(email.trim());
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend the code.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full animate-fade-in flex-col bg-white">
      {/* Header: animated brand gradient with soft drifting orbs and a floating logo */}
      <div className="relative overflow-hidden bg-gradient-to-br from-brand-400 via-brand-600 to-brand-700 bg-[length:200%_200%] px-5 pb-12 pt-7 text-center animate-gradient-pan">
        {/* Ambient depth orbs */}
        <div className="pointer-events-none absolute -left-8 -top-10 h-32 w-32 rounded-full bg-brand-300/40 blur-2xl animate-blob-drift" />
        <div className="pointer-events-none absolute -bottom-10 right-0 h-28 w-28 rounded-full bg-violet-400/30 blur-2xl animate-blob-drift-slow" />
        <div className="pointer-events-none absolute right-8 top-2 h-16 w-16 rounded-full bg-white/20 blur-2xl animate-blob-drift" />

        <div className="relative z-10">
          {/* Logo with a breathing glow ring */}
          <div className="relative mx-auto mb-3 h-12 w-12">
            <div className="absolute inset-0 rounded-2xl bg-white/40 blur-md animate-glow" />
            <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20 text-white ring-1 ring-white/30 backdrop-blur animate-float">
              <BrandMark className="h-7 w-7" />
            </div>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-white">Litos</h1>
          <p className="mx-auto mt-1 max-w-[260px] text-xs leading-relaxed text-brand-100">
            Skip the volume game. Reach the right person.
          </p>
        </div>
      </div>

      {/* Body floats up over the gradient as a rounded sheet - no hard seam */}
      <div className="relative z-10 -mt-6 flex-1 rounded-t-[26px] bg-white px-5 pb-6 pt-6 shadow-[0_-10px_30px_-12px_rgba(31,18,90,0.22)]">
        {step === 'uploading' ? (
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
        ) : step === 'code' ? (
          <form onSubmit={handleVerify} className="flex flex-col gap-4">
            <div className="animate-fade-in-up">
              <h2 className="text-base font-semibold text-gray-900">Check your email</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-500">
                We sent a 6-digit code to <span className="font-medium text-gray-700">{email}</span>.
                Enter it below to verify it's you.
              </p>
            </div>

            {error && <WarningBanner message={error} variant="error" />}

            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              autoFocus
              className="w-full rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2.5 text-center text-xl font-semibold tracking-[0.4em] transition-colors focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
            />

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:bg-brand-700 hover:shadow-card-hover active:scale-[0.98] disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
            >
              {loading ? 'Verifying...' : 'Verify and continue'}
            </button>

            <div className="flex items-center justify-center gap-3 text-[11px] text-gray-400">
              <button type="button" onClick={handleResend} disabled={loading} className="font-medium text-brand-600 hover:text-brand-700 disabled:opacity-60">
                Resend code
              </button>
              <span>·</span>
              <button type="button" onClick={() => { setStep('form'); setError(null); }} className="hover:text-gray-600">
                Wrong email? Go back
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="animate-fade-in-up" style={{ animationDelay: '40ms' }}>
              <h2 className="text-base font-semibold text-gray-900">Let's set you up</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-500">
                Two quick things, then Litos personalizes every message from your real
                background.
              </p>
            </div>

            {error && <WarningBanner message={error} variant="error" />}

            <div className="flex animate-fade-in-up flex-col gap-1.5" style={{ animationDelay: '90ms' }}>
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

            <div className="flex animate-fade-in-up flex-col gap-1.5" style={{ animationDelay: '140ms' }}>
              <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-700">
                  2
                </span>
                Your resume
              </label>
              <div
                onClick={() => fileRef.current?.click()}
                className={`group cursor-pointer rounded-xl border-2 border-dashed px-4 py-5 text-center transition-all duration-200 ${
                  file
                    ? 'border-brand-400 bg-brand-50'
                    : 'border-gray-200 hover:border-brand-300 hover:bg-brand-50/40'
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
                    <svg className="h-6 w-6 text-gray-400 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
              disabled={loading}
              className="w-full animate-fade-in-up rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:bg-brand-700 hover:shadow-card-hover active:scale-[0.98] disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
              style={{ animationDelay: '190ms' }}
            >
              {loading ? 'Sending code...' : 'Get started'}
            </button>

            <p className="animate-fade-in-up text-center text-[11px] leading-relaxed text-gray-400" style={{ animationDelay: '240ms' }}>
              Your resume stays private and is only used to personalize your own drafts.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
