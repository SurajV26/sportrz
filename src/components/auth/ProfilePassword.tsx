'use client';

import { useState, type FormEvent } from 'react';

const inputClass = 'mt-1 w-full rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-600';

export default function ProfilePassword() {
  const [method, setMethod] = useState<'password' | 'otp' | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function submit(url: string, body: object) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Please try again.');
      setMessage(data.message);
      return true;
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    if (fields.password !== fields.confirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    if (await submit('/api/auth/change-password', { ...fields, method })) {
      setMethod(null);
      setSent(false);
    }
  }

  return (
    <section className="m-6 rounded-xl bg-gray-50 p-6 text-gray-900 dark:bg-gray-800 dark:text-white">
      <h2 className="text-lg font-semibold">Change Password</h2>
      <div className="my-3 flex flex-wrap gap-4 text-sm font-semibold">
        {(['password', 'otp'] as const).map(option => (
          <button key={option} type="button" disabled={busy} aria-pressed={method === option}
            className={method === option ? 'underline' : 'text-indigo-600 dark:text-indigo-300'}
            onClick={() => { setMethod(option); setError(''); setMessage(''); }}>
            {option === 'password' ? 'Use current password' : 'Use email OTP'}
          </button>
        ))}
      </div>
      {method === 'otp' && (
        <button type="button" disabled={busy} className="mb-3 rounded-lg border border-indigo-500 px-3 py-2 text-sm"
          onClick={async () => { if (await submit('/api/auth/send-otp', { purpose: 'password_reset' })) setSent(true); }}>
          {sent ? 'Resend OTP' : 'Send OTP to my email'}
        </button>
      )}
      {(method === 'password' || (method === 'otp' && sent)) && (
        <form key={method} onSubmit={save} className="space-y-3">
          {method === 'password' ? (
            <label className="block text-sm">Current Password
              <input name="currentPassword" type="password" autoComplete="current-password" required className={inputClass} />
            </label>
          ) : (
            <label className="block text-sm">Email OTP
              <input name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required className={inputClass} />
            </label>
          )}
          <label className="block text-sm">New Password (6–12 characters)
            <input name="password" type="password" autoComplete="new-password" pattern=".{6,12}" required className={inputClass} />
          </label>
          <label className="block text-sm">Confirm Password
            <input name="confirmPassword" type="password" autoComplete="new-password" required className={inputClass} />
          </label>
          <button disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-white disabled:opacity-60">Save password</button>
        </form>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-300">{error}</p>}
      {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    </section>
  );
}
