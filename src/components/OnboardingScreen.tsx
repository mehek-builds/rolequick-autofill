import React, { useState, useRef } from 'react';
import { createSession, uploadProfile } from '../lib/api';
import { setToken, setProfile } from '../lib/storage';
import type { Profile } from '../lib/types';
import LoadingSpinner from './LoadingSpinner';
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
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="bg-indigo-600 px-4 py-5 text-center">
        <h1 className="text-xl font-bold text-white tracking-tight">Volley</h1>
        <p className="text-indigo-200 text-xs mt-1">Student outreach, powered by real contacts</p>
      </div>

      <div className="flex-1 px-4 py-6">
        {loading ? (
          <LoadingSpinner
            message="Uploading and parsing your resume..."
            size="lg"
          />
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Get started</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Upload your resume so Volley can personalize your outreach.
              </p>
            </div>

            {error && <WarningBanner message={error} variant="error" />}

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-700">
                Email address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@university.edu"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                required
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-700">
                Resume (PDF only)
              </label>
              <div
                onClick={() => fileRef.current?.click()}
                className={`cursor-pointer rounded-md border-2 border-dashed px-4 py-5 text-center transition-colors ${
                  file
                    ? 'border-indigo-400 bg-indigo-50'
                    : 'border-gray-300 hover:border-indigo-400'
                }`}
              >
                {file ? (
                  <div className="flex flex-col items-center gap-1">
                    <svg className="h-6 w-6 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="text-xs font-medium text-indigo-700">{file.name}</span>
                    <span className="text-xs text-gray-400">Click to change</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-1">
                    <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    <span className="text-xs text-gray-500">Click to upload your resume</span>
                    <span className="text-xs text-gray-400">PDF only</span>
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
              className="w-full rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition-colors"
            >
              Get started
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
