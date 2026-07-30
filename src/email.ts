import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./logger";

/** Contact messages are forwarded here. Override with CONTACT_EMAIL_TO. */
const DEFAULT_CONTACT_TO = "aaggraphics@protonmail.com";

let transporter: Transporter | null = null;

export function mailerConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim()
  );
}

function getTransporter(): Transporter {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST!.trim(),
      port,
      secure: port === 465,
      auth: {
        user: process.env.SMTP_USER!.trim(),
        pass: process.env.SMTP_PASS!.trim(),
      },
    });
  }
  return transporter;
}

export function contactInboxAddress(): string {
  return process.env.CONTACT_EMAIL_TO?.trim() || DEFAULT_CONTACT_TO;
}

/**
 * Send a password-reset link to a user. Returns true when handed to SMTP.
 * When SMTP isn't configured the caller still responds generically (never
 * revealing whether the email exists) and the reset simply can't complete.
 */
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string
): Promise<boolean> {
  if (!mailerConfigured()) {
    logger.warn(
      "SMTP not configured — password reset email not sent. Set SMTP_HOST/SMTP_USER/SMTP_PASS to enable resets."
    );
    return false;
  }

  try {
    await getTransporter().sendMail({
      from:
        process.env.SMTP_FROM?.trim() ||
        `"Audrey's Angel Graphics" <${process.env.SMTP_USER!.trim()}>`,
      to,
      subject: "Reset your Audrey's Angel Graphics password",
      text:
        `We received a request to reset the password for your account.\n\n` +
        `Open this link to choose a new password (valid for 1 hour):\n` +
        `${resetUrl}\n\n` +
        `If you didn't ask for this, you can safely ignore this email — ` +
        `your password will not change.\n`,
    });
    return true;
  } catch (err) {
    logger.error("Failed to send password reset email", {
      error: String(err),
    });
    return false;
  }
}

function fromAddress(): string {
  return (
    process.env.SMTP_FROM?.trim() ||
    `"Audrey's Angel Graphics" <${process.env.SMTP_USER!.trim()}>`
  );
}

export function failureAlertAddress(): string {
  return (
    process.env.FAILURE_ALERT_EMAIL?.trim() || "allaudrey22@gmail.com"
  );
}

/**
 * Soft-tone delivery email with the generated angel graphic attached.
 */
export async function sendGraphicDeliveryEmail(input: {
  to: string;
  angelName: string;
  filename: string;
  image: Buffer;
  contentType?: string;
}): Promise<boolean> {
  if (!mailerConfigured()) {
    logger.warn(
      "SMTP not configured — graphic delivery email not sent. Set SMTP_HOST/SMTP_USER/SMTP_PASS."
    );
    return false;
  }

  const name = input.angelName.trim();
  const replyTo =
    process.env.GRAPHIC_REPLY_TO?.trim() || contactInboxAddress();

  try {
    await getTransporter().sendMail({
      from: fromAddress(),
      to: input.to,
      replyTo,
      subject: `Your angel graphic for ${name}`,
      text:
        `Hi,\n\n` +
        `I've attached the angel graphic I made for ${name}. ` +
        `I put a lot of love into it and truly hope it brings you a sense of peace and light whenever you look at it.\n\n` +
        `Thank you for trusting me with something so special. It means more than you know.\n\n` +
        `With love,\n` +
        `Audrey\n` +
        `Audrey's Angel Graphics\n`,
      attachments: [
        {
          filename: input.filename,
          content: input.image,
          contentType: input.contentType || "image/jpeg",
        },
      ],
    });
    return true;
  } catch (err) {
    logger.error("Failed to send graphic delivery email", {
      error: String(err),
      to: input.to,
    });
    return false;
  }
}

/** Alert Audrey when the graphic pipeline fails. */
export async function sendPipelineFailureEmail(input: {
  entryId: string;
  angelName: string;
  email: string | null;
  graphicCode: string | null;
  error: string;
}): Promise<boolean> {
  if (!mailerConfigured()) {
    logger.warn(
      "SMTP not configured — pipeline failure alert not sent."
    );
    return false;
  }

  try {
    await getTransporter().sendMail({
      from: fromAddress(),
      to: failureAlertAddress(),
      subject: `[AAGDB] Graphic pipeline failed — ${input.angelName}`,
      text:
        `A graphic request failed in the automation worker.\n\n` +
        `Entry ID: ${input.entryId}\n` +
        `Angel name: ${input.angelName}\n` +
        `Customer email: ${input.email || "(none)"}\n` +
        `Graphic code: ${input.graphicCode || "(none)"}\n\n` +
        `Error:\n${input.error}\n\n` +
        `Check the admin portal for the failure banner / Requests → Failed.\n`,
    });
    return true;
  } catch (err) {
    logger.error("Failed to send pipeline failure alert", {
      error: String(err),
    });
    return false;
  }
}

/**
 * Forward a contact-page message to the studio inbox (ProtonMail).
 * Returns true when the email was handed to the SMTP server. The message is
 * always stored in Postgres first, so a mail failure never loses it.
 */
export async function sendContactEmail(input: {
  name: string;
  email: string;
  message: string;
}): Promise<boolean> {
  if (!mailerConfigured()) {
    logger.warn(
      "SMTP not configured — contact message stored in DB only. Set SMTP_HOST/SMTP_USER/SMTP_PASS to forward to the inbox."
    );
    return false;
  }

  try {
    await getTransporter().sendMail({
      from:
        process.env.SMTP_FROM?.trim() ||
        `"Audrey's Angel Graphics" <${process.env.SMTP_USER!.trim()}>`,
      to: contactInboxAddress(),
      replyTo: `"${input.name.replace(/"/g, "'")}" <${input.email}>`,
      subject: `New contact message from ${input.name}`,
      text:
        `New message from the contact page:\n\n` +
        `Name:  ${input.name}\n` +
        `Email: ${input.email}\n\n` +
        `Message:\n${input.message}\n`,
    });
    return true;
  } catch (err) {
    logger.error("Failed to forward contact message via email", {
      error: String(err),
    });
    return false;
  }
}
