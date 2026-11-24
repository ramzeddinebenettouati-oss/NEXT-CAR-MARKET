import { Resend } from "resend";

const DEFAULT_FROM = "support@nextcarmarket.com";

function getApiKey(): string | undefined {
  const key = process.env.RESEND_API_KEY;
  if (!key || !key.startsWith("re_")) return undefined;
  return key;
}

// Created on first use so the server can boot without RESEND_API_KEY
// (the Resend constructor throws when the key is missing).
let resendClient: Resend | null = null;
function getClient(): Resend {
  const key = getApiKey();
  if (!key) throw new Error("Resend API key is not configured or invalid");
  if (!resendClient) resendClient = new Resend(key);
  return resendClient;
}

export interface SendEmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}

export async function sendEmail(opts: SendEmailOptions) {
  const { data, error } = await getClient().emails.send({
    from: opts.from,
    to: Array.isArray(opts.to) ? opts.to : [opts.to],
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    replyTo: opts.replyTo,
    // Resend's type wants at least one of text/html; callers always pass one.
  } as Parameters<Resend["emails"]["send"]>[0]);

  if (error) throw new Error(error.message);
  return data;
}

export function getDefaultFromAddress(): string {
  const fromEnv = process.env.RESEND_FROM_EMAIL;
  if (fromEnv && fromEnv.includes("@") && !fromEnv.startsWith("0")) return fromEnv;
  return DEFAULT_FROM;
}

export function isResendConfigured(): boolean {
  return !!getApiKey();
}

export function isCustomDomainConfigured(): boolean {
  const from = getDefaultFromAddress();
  return !from.includes("resend.dev");
}
