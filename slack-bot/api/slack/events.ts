/**
 * Vercel function entry. Slack POSTs every slash command, view_submission,
 * and block_actions payload to this single URL.
 *
 * Deployment URL: https://<your-vercel-domain>/api/slack/events
 *
 * Uses the Node.js (IncomingMessage / ServerResponse) handler signature.
 * The Web-standards `Request` style is not reliably supported by Vercel's
 * Node.js runtime for default-export handlers; see VercelReceiver for the
 * raw-body extraction that makes Slack signature verification work in both
 * "stream not yet consumed" and "@vercel/node already buffered the body"
 * cases.
 */

import type {IncomingMessage, ServerResponse} from 'node:http';
import {getApp, getReceiver} from '../../src/app.js';

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Importing getApp() registers the slash-command and view-submission
  // handlers on first invocation.
  getApp();
  await getReceiver().handle(req, res);
}
