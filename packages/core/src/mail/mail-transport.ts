import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from '@axp/config';
import type { Logger } from '@axp/observability';

/**
 * Outgoing mail (Master Spec §15: in-app first, selective mail).
 *
 * One message is one recipient: a report or a notice never lists who else
 * received it. An attachment exists in memory while it is sent and is not
 * written anywhere.
 */
export interface MailMessage {
  readonly to: { readonly address: string; readonly name: string };
  readonly subject: string;
  readonly text: string;
  readonly attachments?: readonly {
    readonly filename: string;
    readonly content: Buffer;
    readonly contentType: string;
  }[];
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/**
 * Development transport: says that a mail went out, and to how many words of
 * which subject - never the body or an attachment, which may hold analytics
 * values, and never the address.
 */
export class ConsoleMailTransport implements MailTransport {
  constructor(private readonly logger: Logger) {}

  async send(message: MailMessage): Promise<void> {
    this.logger.info(
      {
        mail: {
          subject: message.subject,
          attachments: (message.attachments ?? []).map((attachment) => ({
            filename: attachment.filename,
            bytes: attachment.content.length,
          })),
        },
      },
      'Mail handed to the console transport',
    );
  }
}

export class SmtpMailTransport implements MailTransport {
  private readonly transporter: Transporter;

  constructor(private readonly config: AppConfig['mail']) {
    this.transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort ?? 25,
      secure: config.smtpSecure,
      ...(config.smtpUser
        ? { auth: { user: config.smtpUser, pass: config.smtpPassword ?? '' } }
        : {}),
      // Attachments are buffers produced here, never paths or URLs.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to: { name: message.to.name, address: message.to.address },
      subject: message.subject,
      text: message.text,
      attachments: (message.attachments ?? []).map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
      })),
    });
  }
}

/** Test transport: keeps what was sent, in memory, for the test to read. */
export class MemoryMailTransport implements MailTransport {
  readonly outbox: MailMessage[] = [];
  failNext = 0;

  async send(message: MailMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('Simulated mail transport failure.');
    }
    this.outbox.push(message);
  }
}

export function createMailTransport(config: AppConfig, logger: Logger): MailTransport {
  return config.mail.transport === 'smtp'
    ? new SmtpMailTransport(config.mail)
    : new ConsoleMailTransport(logger);
}
