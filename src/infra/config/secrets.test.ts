import { describe, expect, it } from 'vitest';
import { minimalRawConfig } from '../../../test/helpers.js';
import { parseConfig } from './parse.js';
import { secretsOf } from './secrets.js';

describe('parseConfig', () => {
  it('lists the tokens, Discord user id, calendar links and healthcheck url as secrets', () => {
    const config = parseConfig({
      ...minimalRawConfig(),
      discord: { bot_token: 'discord-token', user_id: '123456789012345678' },
      calendar: { ics_urls: ['webcal://example.com/private-abc.ics'] },
    });
    expect(secretsOf(config)).toEqual([
      '123456789:AAEexampleexampleexampleexampleexample',
      'discord-token',
      '123456789012345678',
      'webcal://example.com/private-abc.ics',
      'https://example.com/private-abc.ics',
    ]);
  });
});
