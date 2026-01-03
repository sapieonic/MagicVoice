import twilio from 'twilio';
import dotenv from 'dotenv';
import { Request } from 'express';
import { createLogger } from '../logger.js';

dotenv.config();

const log = createLogger('twilio-utils');
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

if (!accountSid || !authToken || !twilioPhoneNumber) {
  log.warn('Twilio credentials not configured. Twilio features will be disabled.');
}

const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

export { client as twilioClient, twilioPhoneNumber };

export function getTwilioWebhookUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

export function validateTwilioRequest(
  req: Request, 
  authToken: string, 
  url: string
): boolean {
  const twilioSignature = req.headers['x-twilio-signature'] as string;
  return twilio.validateRequest(
    authToken,
    twilioSignature,
    url,
    req.body
  );
}