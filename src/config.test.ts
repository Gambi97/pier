import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  validateMethods,
  validatePlatformKey,
  validateProjectName,
} from './config.js';

describe('validateProjectName', () => {
  it('accepts DNS-safe names (keel parity)', () => {
    expect(validateProjectName(' pizza ')).toBe('pizza');
    expect(validateProjectName('my-app-2')).toBe('my-app-2');
  });

  it('rejects what keel rejects', () => {
    for (const bad of ['My-App', '-app', 'app-', '2app', 'a--b', '']) {
      expect(() => validateProjectName(bad), bad).toThrow(ConfigError);
    }
  });
});

describe('validatePlatformKey', () => {
  it('accepts ak_ keys', () => {
    expect(validatePlatformKey(' ak_abc123 ')).toBe('ak_abc123');
  });

  it('rejects secret keys with guidance', () => {
    expect(() => validatePlatformKey('sk_test_xyz')).toThrow(/platform key/i);
  });
});

describe('validateMethods', () => {
  it('parses, trims and dedupes', () => {
    expect(validateMethods(['google', ' password ', 'google'])).toEqual(['google', 'password']);
  });

  it('rejects unknown methods and empty selections', () => {
    expect(() => validateMethods(['sms'])).toThrow(ConfigError);
    expect(() => validateMethods([])).toThrow(ConfigError);
  });
});
