import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {describe, expect, it} from 'vitest';
import {parseSlackBody, readRawBody} from '../src/receiver.js';

/** Make a fake IncomingMessage-like object backed by a Readable stream. */
function streamReq(body: string, contentType: string): IncomingMessage {
  const stream = Readable.from([Buffer.from(body, 'utf-8')]);
  Object.assign(stream, {
    headers: {'content-type': contentType},
  });
  return stream as unknown as IncomingMessage;
}

/** Make a fake IncomingMessage-like object with the stream already consumed
 *  and body pre-parsed by @vercel/node's body parser. */
function bufferedReq(
  parsedBody: unknown,
  contentType: string,
): IncomingMessage {
  return {
    readable: false,
    headers: {'content-type': contentType},
    body: parsedBody,
  } as unknown as IncomingMessage;
}

describe('readRawBody', () => {
  it('reads from a live stream when available', async () => {
    const req = streamReq('command=%2Ftm-newgame&user_id=U123', 'application/x-www-form-urlencoded');
    const out = await readRawBody(req);
    expect(out).toBe('command=%2Ftm-newgame&user_id=U123');
  });

  it('falls back to req.body string when stream is consumed', async () => {
    const req = bufferedReq('command=%2Ftm-newgame', 'application/x-www-form-urlencoded');
    expect(await readRawBody(req)).toBe('command=%2Ftm-newgame');
  });

  it('falls back to req.body Buffer when stream is consumed', async () => {
    const req = bufferedReq(Buffer.from('payload=%7B%22x%22%3A1%7D'), 'application/x-www-form-urlencoded');
    expect(await readRawBody(req)).toBe('payload=%7B%22x%22%3A1%7D');
  });

  it('reconstructs form-urlencoded body from parsed object', async () => {
    const parsed = {command: '/tm-newgame', user_id: 'U123', team: 'T0001'};
    const req = bufferedReq(parsed, 'application/x-www-form-urlencoded');
    const out = await readRawBody(req);
    const params = new URLSearchParams(out);
    expect(params.get('command')).toBe('/tm-newgame');
    expect(params.get('user_id')).toBe('U123');
    expect(params.get('team')).toBe('T0001');
  });

  it('handles parsed payloads with array-valued fields', async () => {
    const parsed = {commands: ['a', 'b']};
    const req = bufferedReq(parsed, 'application/x-www-form-urlencoded');
    const out = await readRawBody(req);
    expect(new URLSearchParams(out).getAll('commands')).toEqual(['a', 'b']);
  });

  it('JSON-stringifies parsed JSON objects as last resort', async () => {
    const parsed = {challenge: 'abc', type: 'url_verification'};
    const req = bufferedReq(parsed, 'application/json');
    const out = await readRawBody(req);
    expect(JSON.parse(out)).toEqual(parsed);
  });

  it('returns empty string when body is null/undefined and stream is consumed', async () => {
    expect(await readRawBody(bufferedReq(undefined, 'application/json'))).toBe('');
    expect(await readRawBody(bufferedReq(null, 'application/json'))).toBe('');
  });
});

describe('parseSlackBody', () => {
  it('parses slash-command form bodies', () => {
    const out = parseSlackBody('application/x-www-form-urlencoded', 'command=%2Ftm-newgame&user_id=U123');
    expect(out).toEqual({command: '/tm-newgame', user_id: 'U123'});
  });

  it('parses interactivity payloads (form body wrapping a JSON `payload` field)', () => {
    const payload = {type: 'view_submission', user: {id: 'U1'}};
    const raw = 'payload=' + encodeURIComponent(JSON.stringify(payload));
    const out = parseSlackBody('application/x-www-form-urlencoded', raw);
    expect(out).toEqual(payload);
  });

  it('parses JSON bodies', () => {
    const out = parseSlackBody('application/json', '{"type":"url_verification","challenge":"abc"}');
    expect(out).toEqual({type: 'url_verification', challenge: 'abc'});
  });

  it('throws on unknown content-type', () => {
    expect(() => parseSlackBody('text/xml', '<x/>')).toThrow(/unsupported content-type/i);
  });
});
