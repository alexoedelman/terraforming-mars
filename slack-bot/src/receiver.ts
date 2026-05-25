/**
 * Custom Bolt receiver for Vercel Node.js functions.
 *
 * Why a custom receiver?
 * - Bolt's built-in HTTPReceiver wraps Node's http.createServer and can't run
 *   in a per-request serverless environment.
 * - Vercel's Node.js runtime passes IncomingMessage / ServerResponse. The
 *   body may already be buffered by `@vercel/node`'s auto body-parser, so we
 *   try the stream first and fall back to reconstructing from `req.body`.
 * - Slack signature verification requires the raw request body bytes; for
 *   form-urlencoded payloads (slash commands + interactivity, which is all
 *   we receive) reconstruction via URLSearchParams produces a byte-identical
 *   string, so signature verification still works in the fallback path.
 */

import crypto from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {App, Receiver, ReceiverEvent} from '@slack/bolt';

export interface VercelReceiverOptions {
  signingSecret: string;
  /** Max seconds a Slack request timestamp can lag before we reject it. */
  signatureToleranceSeconds?: number;
}

export class VercelReceiver implements Receiver {
  private bolt?: App;
  private readonly signingSecret: string;
  private readonly toleranceSeconds: number;

  public constructor(options: VercelReceiverOptions) {
    this.signingSecret = options.signingSecret;
    this.toleranceSeconds = options.signatureToleranceSeconds ?? 60 * 5;
  }

  public init(app: App): void {
    this.bolt = app;
  }

  // Bolt's Receiver contract; not used in serverless.
  public async start(): Promise<this> {
    return this;
  }
  public async stop(): Promise<void> {}

  /**
   * Entry point invoked by the Vercel function handler. Reads + verifies the
   * Slack request, dispatches to Bolt, and writes the HTTP response.
   */
  public async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.bolt === undefined) {
      sendPlainResponse(res, 500, 'Bolt App not initialized');
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      console.error('[slack-bot] failed to read request body', err);
      sendPlainResponse(res, 400, 'Could not read request body');
      return;
    }

    const timestamp = headerString(req, 'x-slack-request-timestamp');
    const signature = headerString(req, 'x-slack-signature');

    if (timestamp === undefined || signature === undefined) {
      sendPlainResponse(res, 401, 'Missing Slack signature headers');
      return;
    }

    if (!this.verifySignature(timestamp, rawBody, signature)) {
      sendPlainResponse(res, 401, 'Invalid Slack signature');
      return;
    }

    const contentType = headerString(req, 'content-type') ?? '';
    let body: Record<string, unknown>;
    try {
      body = parseSlackBody(contentType, rawBody);
    } catch (err) {
      console.error('[slack-bot] failed to parse body', err);
      sendPlainResponse(res, 400, 'Bad request');
      return;
    }

    // Slack Events API URL-verification handshake (defensive; not used today).
    if (body.type === 'url_verification' && typeof body.challenge === 'string') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end(body.challenge);
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const event: ReceiverEvent = {
        body,
        ack: async (response) => {
          if (settled) return;
          settled = true;
          sendAckResponse(res, response);
          resolve();
        },
      };

      this.bolt!.processEvent(event).then(
        () => {
          if (!settled) {
            settled = true;
            sendPlainResponse(res, 200, '');
            resolve();
          }
        },
        (err) => {
          console.error('[slack-bot] processEvent error', err);
          if (!settled) {
            settled = true;
            sendPlainResponse(res, 500, 'Internal error');
            resolve();
          }
        },
      );
    });
  }

  private verifySignature(timestamp: string, body: string, signature: string): boolean {
    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) return false;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > this.toleranceSeconds) return false;

    const baseString = `v0:${timestamp}:${body}`;
    const expected = `v0=${crypto.createHmac('sha256', this.signingSecret).update(baseString).digest('hex')}`;

    const sigBuf = Buffer.from(signature, 'utf-8');
    const expBuf = Buffer.from(expected, 'utf-8');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }
}

/**
 * Read the raw request body, preferring the live stream and falling back to
 * `req.body` if `@vercel/node` already buffered/parsed it.
 *
 * Cases handled:
 *   1. Stream still readable -> consume it directly (true raw bytes).
 *   2. `req.body` is a string -> use as-is.
 *   3. `req.body` is a Buffer -> decode to utf-8.
 *   4. `req.body` is an object + content-type is form -> reconstruct via
 *      URLSearchParams (byte-identical for Slack's payloads).
 *   5. `req.body` is an object + content-type is JSON -> JSON.stringify
 *      (lossy, but only the Events API URL-verification handshake hits this,
 *      and that path doesn't require signature verification on the recon-
 *      structed body).
 */
export async function readRawBody(req: IncomingMessage): Promise<string> {
  if (req.readable) {
    const chunks: Array<Buffer> = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  const body = (req as IncomingMessage & {body?: unknown}).body;
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf-8');

  const contentType = (headerString(req, 'content-type') ?? '').toLowerCase();
  if (typeof body === 'object') {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          for (const item of v) params.append(k, String(item));
        } else {
          params.append(k, String(v));
        }
      }
      return params.toString();
    }
    return JSON.stringify(body);
  }
  return String(body);
}

export function parseSlackBody(contentType: string, rawBody: string): Record<string, unknown> {
  if (contentType.includes('application/json')) {
    return JSON.parse(rawBody) as Record<string, unknown>;
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(rawBody);
    const obj: Record<string, string> = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    // Interactive payloads (view_submission, block_actions, etc.) come as a
    // form-urlencoded body with a single `payload` field whose value is JSON.
    if (typeof obj.payload === 'string') {
      return JSON.parse(obj.payload) as Record<string, unknown>;
    }
    return obj;
  }
  throw new Error(`Unsupported content-type: ${contentType}`);
}

function sendAckResponse(res: ServerResponse, response: unknown): void {
  if (response === undefined || response === null || response === '') {
    sendPlainResponse(res, 200, '');
    return;
  }
  if (typeof response === 'string') {
    sendPlainResponse(res, 200, response);
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(response));
}

function sendPlainResponse(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain');
  res.end(body);
}

function headerString(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}
