import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Logger,
  clearRegisteredSecrets,
  redact,
  redactValue,
  registerSecret,
} from '../../src/util/logger';

/**
 * Spec §10 rule 13: a token must never be logged or persisted in any form.
 * These are the tests that hold that guarantee.
 */
describe('secret redaction', () => {
  afterEach(() => {
    clearRegisteredSecrets();
    vi.restoreAllMocks();
  });

  it('redacts a registered secret wherever it appears', () => {
    registerSecret('NDkyMzk4NzM0OTg3MzQ5OA');
    const output = redact('request failed for token NDkyMzk4NzM0OTg3MzQ5OA on /rest/api/content');
    expect(output).not.toContain('NDkyMzk4NzM0OTg3MzQ5OA');
    expect(output).toContain('[REDACTED]');
  });

  it('redacts every occurrence, not just the first', () => {
    registerSecret('supersecretvalue');
    const output = redact('supersecretvalue and again supersecretvalue');
    expect(output).not.toContain('supersecretvalue');
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it('ignores values too short to be a credential', () => {
    registerSecret('abc');
    expect(redact('abc is fine')).toBe('abc is fine');
  });

  it('treats registered secrets as literals, not patterns', () => {
    // A token containing regex metacharacters must not corrupt the expression.
    registerSecret('a.b*c+d(e)');
    expect(redact('value a.b*c+d(e) here')).toBe('value [REDACTED] here');
    expect(redact('value axbxcxdxe here')).toBe('value axbxcxdxe here');
  });

  it('redacts bearer tokens without prior registration', () => {
    const output = redact('Authorization: Bearer abc123DEF456ghi789');
    expect(output).not.toContain('abc123DEF456ghi789');
  });

  it('redacts credential-shaped object fields', () => {
    expect(redact('{"pat":"abc123DEF456"}')).not.toContain('abc123DEF456');
    expect(redact('{"password":"hunter2xyz"}')).not.toContain('hunter2xyz');
    expect(redact('token=abc123DEF456')).not.toContain('abc123DEF456');
  });

  it('leaves ordinary content untouched', () => {
    const message = 'Pulled 42 pages from space ENG in 1.3s';
    expect(redact(message)).toBe(message);
  });

  it('clears registered secrets on request', () => {
    registerSecret('supersecretvalue');
    clearRegisteredSecrets();
    expect(redact('supersecretvalue')).toBe('supersecretvalue');
  });
});

describe('redactValue', () => {
  afterEach(clearRegisteredSecrets);

  it('redacts strings', () => {
    registerSecret('supersecretvalue');
    expect(redactValue('supersecretvalue')).toBe('[REDACTED]');
  });

  it('redacts a token that leaked into an error message', () => {
    registerSecret('supersecretvalue');
    const output = redactValue(new Error('auth failed with supersecretvalue'));
    expect(output).not.toContain('supersecretvalue');
    expect(output).toContain('Error:');
  });

  it('serialises plain objects', () => {
    expect(redactValue({ pages: 3 })).toBe('{"pages":3}');
  });

  it('survives circular structures', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(redactValue(circular)).toBe('[unserialisable]');
  });

  it('handles values JSON.stringify returns undefined for', () => {
    expect(redactValue(undefined)).toBe('undefined');
  });
});

describe('Logger', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    clearRegisteredSecrets();
    vi.restoreAllMocks();
  });

  it('suppresses debug output when debug logging is off', () => {
    new Logger('test', () => false).debug('hidden');
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('emits debug output when debug logging is on', () => {
    new Logger('test', () => true).debug('shown');
    expect(debugSpy).toHaveBeenCalledOnce();
  });

  it('re-reads the debug flag on every call', () => {
    let enabled = false;
    const logger = new Logger('test', () => enabled);
    logger.debug('first');
    enabled = true;
    logger.debug('second');
    expect(debugSpy).toHaveBeenCalledOnce();
  });

  // `info` reaches the console on the debug channel, which a devtools console hides
  // by default — Obsidian's review asks plugins not to log routinely, and `warn` and
  // `error` are the two levels a reader is meant to see.
  it('emits info, warn and error regardless of the debug flag', () => {
    const logger = new Logger('test', () => false);
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(debugSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('redacts both the message and its arguments', () => {
    registerSecret('supersecretvalue');
    new Logger('test', () => true).error('failed supersecretvalue', {
      token: 'supersecretvalue',
    });
    const output = errorSpy.mock.calls[0]?.join(' ') ?? '';
    expect(output).not.toContain('supersecretvalue');
  });

  it('prefixes output with its scope', () => {
    new Logger('sync', () => true).info('message');
    expect(debugSpy.mock.calls[0]?.[0]).toBe('[confluence-dc:sync]');
  });

  it('composes scopes for child loggers', () => {
    new Logger('sync', () => true).child('pull').info('message');
    expect(debugSpy.mock.calls[0]?.[0]).toBe('[confluence-dc:sync:pull]');
  });

  it('inherits the debug flag in child loggers', () => {
    new Logger('sync', () => true).child('pull').debug('message');
    expect(debugSpy).toHaveBeenCalledOnce();
  });
});
