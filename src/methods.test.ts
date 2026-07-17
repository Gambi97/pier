import { describe, expect, it } from 'vitest';

import { AUTH_METHODS, buildPatch } from './methods.js';

// The top-level property names pinned live from `clerk config schema`
// (platform-config/2025-01-01) on 2026-07-16.
const LIVE_SCHEMA = ['connection_oauth_google', 'auth_password', 'auth_email', 'session'];

describe('buildPatch', () => {
  it('enables google as a connection toggle — and writes password OFF (Clerk default is on)', () => {
    const plan = buildPatch(['google'], LIVE_SCHEMA);
    expect(plan.patch).toEqual({
      connection_oauth_google: { enabled: true },
      auth_password: { enabled: false, required: false },
    });
    expect(plan.dropped).toEqual([]);
  });

  it('enables password under its own top-level key, with the verified-email base', () => {
    const plan = buildPatch(['password'], LIVE_SCHEMA);
    expect(plan.patch).toEqual({
      connection_oauth_google: { enabled: false },
      auth_password: { enabled: true },
      auth_email: {
        used_for_sign_up: true,
        required_for_sign_up: true,
        verify_at_sign_up: true,
        verification_strategies: ['email_code'],
        used_for_sign_in: false,
      },
    });
  });

  it('models magic link and OTP as one sign_in_strategies array, not merged toggles', () => {
    const plan = buildPatch(['magic-link', 'email-otp'], LIVE_SCHEMA);
    expect(plan.patch).toEqual({
      connection_oauth_google: { enabled: false },
      auth_password: { enabled: false, required: false },
      auth_email: {
        used_for_sign_up: true,
        required_for_sign_up: true,
        verify_at_sign_up: true,
        verification_strategies: ['email_code'],
        used_for_sign_in: true,
        sign_in_strategies: ['email_code', 'email_link'],
      },
    });
  });

  it('writes the unselected password off for the exact google+email-otp selection', () => {
    // The live regression: google+email-otp left Clerk's default password
    // sign-up (enabled AND required) in place — the form asked a password.
    const plan = buildPatch(['google', 'email-otp'], LIVE_SCHEMA);
    expect(plan.patch.auth_password).toEqual({ enabled: false, required: false });
    expect((plan.patch.auth_email as { sign_in_strategies: string[] }).sign_in_strategies).toEqual([
      'email_code',
    ]);
  });

  it('composes the full v1 selection', () => {
    const plan = buildPatch([...AUTH_METHODS], LIVE_SCHEMA);
    expect(plan.dropped).toEqual([]);
    expect(Object.keys(plan.patch).sort()).toEqual([
      'auth_email',
      'auth_password',
      'connection_oauth_google',
    ]);
  });

  it('drops methods whose key the live schema does not know, keeping the rest', () => {
    const plan = buildPatch(['google', 'password'], ['auth_password', 'auth_email']);
    expect(plan.dropped).toEqual(['google']);
    expect(plan.patch.auth_password).toEqual({ enabled: true });
    expect(plan.warnings).toEqual([]);
  });

  it('warns (without dropping) when password loses its verified-email base', () => {
    const plan = buildPatch(['password'], ['auth_password']);
    expect(plan.dropped).toEqual([]);
    expect(plan.patch).toEqual({ auth_password: { enabled: true } });
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/auth_email/);
  });

  it('drops everything against an empty schema without throwing', () => {
    const plan = buildPatch([...AUTH_METHODS], []);
    expect(plan.dropped).toEqual([...AUTH_METHODS]);
    expect(plan.patch).toEqual({});
  });

  it("points Clerk's paths at the scaffold routes when the schema has them", () => {
    const plan = buildPatch(['password'], [...LIVE_SCHEMA, 'paths']);
    expect(plan.patch.paths).toEqual({ home: '/', sign_in: '/sign-in', sign_up: '/sign-up' });
    // And silently skips them on a schema that lacks the key.
    expect(buildPatch(['password'], LIVE_SCHEMA).patch.paths).toBeUndefined();
  });
});
