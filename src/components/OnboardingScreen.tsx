import React, { useRef, useState } from 'react';
import { createSession, requestCode, uploadProfile, verifyCode } from '../lib/api';
import { setProfile, setToken } from '../lib/storage';
import type { Profile } from '../lib/types';
import WarningBanner from './WarningBanner';
import {
  fieldClass,
  PopupHeader,
  primaryButtonClass,
  textButtonClass,
} from './ui';

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
    const nextFile = e.target.files?.[0];
    if (!nextFile) return;
    if (nextFile.type !== 'application/pdf') {
      setError('Upload your resume as a PDF.');
      return;
    }
    setError(null);
    setFile(nextFile);
  };

  const finishSignup = async (sessionToken: string) => {
    setStep('uploading');
    await setToken(sessionToken);
    const profile = await uploadProfile(sessionToken, file!);
    await setProfile(profile);
    onComplete(profile, sessionToken);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError('Enter your email.');
      return;
    }
    if (!file) {
      setError('Add your resume PDF.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      await requestCode(email.trim());
      setCode('');
      setStep('code');
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('503') || message.includes('verification_unavailable')) {
        try {
          const { token } = await createSession(email.trim());
          await finishSignup(token);
          return;
        } catch (sessionError) {
          setError(sessionError instanceof Error ? sessionError.message : 'Could not create your account.');
          setStep('form');
        }
      } else {
        setError(message || 'Could not send the verification code. Try again.');
        setStep('form');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code from your email.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const { token } = await verifyCode(email.trim(), code.trim());
      await finishSignup(token);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed.';
      setError(
        message.includes('Incorrect') || message.includes('400')
          ? 'That code is not right. Check your email and try again.'
          : message,
      );
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
      <PopupHeader />

      <main className="flex flex-1 flex-col px-5 py-5">
        {step === 'uploading' ? (
          <div className="flex flex-1 flex-col items-start justify-center gap-4" role="status" aria-live="polite">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-brand-100 border-t-brand-600" aria-hidden="true" />
            <div>
              <h1 className="text-xl font-semibold text-gray-950">Reading your resume</h1>
              <p className="mt-1 text-sm leading-5 text-gray-600">
                Litos is pulling out your experience for tailored applications.
              </p>
            </div>
          </div>
        ) : step === 'code' ? (
          <form onSubmit={handleVerify} className="flex flex-col gap-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-gray-600">Step 2 of 2</p>
              <h1 className="mt-2 text-xl font-semibold text-gray-950">Check your email</h1>
              <p id="code-help" className="mt-1 text-sm leading-5 text-gray-600">
                Enter the code sent to <span className="font-medium text-gray-800">{email}</span>.
              </p>
            </div>

            {error && <WarningBanner message={error} variant="error" />}

            <div className="flex flex-col gap-2">
              <label htmlFor="verification-code" className="text-sm font-medium text-gray-800">
                Verification code
              </label>
              <input
                id="verification-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                autoFocus
                aria-describedby="code-help"
                className={`${fieldClass} h-14 text-center text-xl font-semibold tracking-[0.28em]`}
              />
            </div>

            <button type="submit" disabled={loading} className={primaryButtonClass}>
              {loading ? 'Verifying…' : 'Verify and continue'}
            </button>

            <div className="flex items-center gap-2">
              <button type="button" onClick={handleResend} disabled={loading} className={textButtonClass}>
                Resend code
              </button>
              <span className="text-gray-400" aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => {
                  setStep('form');
                  setError(null);
                }}
                className={textButtonClass}
              >
                Change email
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-gray-600">Step 1 of 2</p>
              <h1 className="mt-2 text-xl font-semibold text-gray-950">Set up Litos</h1>
              <p className="mt-1 text-sm leading-5 text-gray-600">
                Add your email and resume. You can review everything Litos creates.
              </p>
            </div>

            {error && <WarningBanner message={error} variant="error" />}

            <div className="flex flex-col gap-2">
              <label htmlFor="signup-email" className="text-sm font-medium text-gray-800">
                Email address
              </label>
              <input
                id="signup-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@university.edu"
                className={fieldClass}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <div>
                <p className="text-sm font-medium text-gray-800">Resume</p>
                <p id="resume-help" className="mt-0.5 text-xs text-gray-600">PDF, up to the limit shown by Chrome.</p>
              </div>
              <input
                ref={fileRef}
                id="resume-upload"
                type="file"
                accept="application/pdf"
                className="peer sr-only"
                onChange={handleFileChange}
                aria-describedby="resume-help"
              />
              <label
                htmlFor="resume-upload"
                className={`flex min-h-28 cursor-pointer items-center gap-3 rounded-md border border-dashed px-4 transition-[border-color,background-color,box-shadow] peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 ${
                  file
                    ? 'border-brand-300 bg-brand-50'
                    : 'border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-white'
                }`}
              >
                <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-700" aria-hidden="true">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-gray-900">
                    {file ? file.name : 'Choose your resume'}
                  </span>
                  <span className="mt-0.5 block text-xs text-gray-600">
                    {file ? 'Choose a different PDF' : 'Click or press Enter to browse'}
                  </span>
                </span>
              </label>
            </div>

            <button type="submit" disabled={loading} className={primaryButtonClass}>
              {loading ? 'Sending code…' : 'Continue'}
            </button>

            <p className="border-t border-gray-200 pt-4 text-xs leading-5 text-gray-600">
              Your resume stays private and is used only to build your applications and drafts.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
