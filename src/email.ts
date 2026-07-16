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
