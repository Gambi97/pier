import { describe, expect, it } from 'vitest';

import { AUTH_METHODS, buildPatch } from './methods.js';

const FULL_SCHEMA = ['connection_oauth_google', 'auth_email', 'session', 'sign_in'];

describe('buildPatch', () => {
  it('builds the google fragment against a schema that knows it', () => {
    const plan = buildPatch(['google'], FULL_SCHEMA);
    expect(plan.patch).toEqual({ connection_oauth_google: { enabled: true } });
    expect(plan.dropped).toEqual([]);
  });

  it('deep-merges the email family instead of overwriting', () => {
    const plan = buildPatch(['password', 'magic-link', 'email-otp'], FULL_SCHEMA);
    expect(plan.patch).toEqual({
      auth_email: {
        enabled: true,
        password: { enabled: true },
        email_link: { enabled: true },
        email_code: { enabled: true },
      },
    });
  });

  it('drops methods whose key the live schema does not know, keeping the rest', () => {
    const plan = buildPatch(['google', 'password'], ['auth_email']);
    expect(plan.dropped).toEqual(['google']);
    expect(plan.patch).toEqual({
      auth_email: { enabled: true, password: { enabled: true } },
    });
  });

  it('drops everything against an empty schema without throwing', () => {
    const plan = buildPatch([...AUTH_METHODS], []);
    expect(plan.dropped).toEqual([...AUTH_METHODS]);
    expect(plan.patch).toEqual({});
  });
});
