export interface LocalInitialAccount { account: string; password: string; }

/** Matches a local username; the production store requires >=12 characters for its first password. */
export function parseLocalInitialAccount(input: unknown): LocalInitialAccount {
  const invalid = () => new Error('local_initial_account_invalid');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.account !== 'string' || typeof value.password !== 'string') throw invalid();
  const account = value.account.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{2,31}$/u.test(account) || value.password.length < 12 || value.password.length > 128
    || /[\u0000-\u001f\u007f]/u.test(value.password)) throw invalid();
  return { account, password: value.password };
}
