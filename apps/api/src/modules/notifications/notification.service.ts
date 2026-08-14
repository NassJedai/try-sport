import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@try/logger';
import type { AppConfig } from '@try/config';
import type { Locale } from '@try/contracts';
import { CONFIG } from '../../common/config.module.js';
import { LOGGER } from '../../common/logger.module.js';

/**
 * Notification transport boundary.
 *
 * Every send is fire-and-forget from the caller's perspective: a booking is
 * confirmed the moment the transaction commits, and an email provider outage must
 * never roll that back or make the user wait. Failures are logged and retried by
 * the queue, not surfaced to the request.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT');

/**
 * Development transport. It logs instead of sending, and says so — it does not
 * pretend a message was delivered.
 */
@Injectable()
export class ConsoleEmailTransport implements EmailTransport {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  send(message: EmailMessage): Promise<void> {
    this.logger.info(
      { to: message.to, subject: message.subject },
      'email not sent (no transport configured); logged only',
    );
    return Promise.resolve();
  }
}

@Injectable()
export class NotificationService {
  constructor(
    @Inject(EMAIL_TRANSPORT) private readonly email: EmailTransport,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async sendLoginCode(input: {
    email: string;
    code: string;
    locale: Locale;
    expiresInMinutes: number;
  }): Promise<void> {
    await this.safeSend({
      to: input.email,
      subject: `${input.code} — ton code de connexion TRY`,
      body: [
        `Ton code de connexion est ${input.code}.`,
        `Il expire dans ${input.expiresInMinutes} minutes.`,
        `Si tu n'as pas demandé ce code, ignore simplement cet e-mail.`,
      ].join('\n\n'),
    });
  }

  async sendBookingConfirmation(input: {
    email: string;
    firstName: string | null;
    offerTitle: string;
    venueName: string;
    whenLabel: string;
    checkInCode: string;
  }): Promise<void> {
    await this.safeSend({
      to: input.email,
      subject: `C'est réservé — ${input.offerTitle}`,
      body: [
        `${input.firstName ? `Salut ${input.firstName},` : 'Salut,'}`,
        `Ta séance « ${input.offerTitle} » chez ${input.venueName} est confirmée pour ${input.whenLabel}.`,
        `Présente ton QR code sur place, ou donne ce code : ${input.checkInCode}.`,
        `À très vite.`,
      ].join('\n\n'),
    });
  }

  async sendReminder(input: {
    email: string;
    offerTitle: string;
    venueName: string;
    whenLabel: string;
  }): Promise<void> {
    await this.safeSend({
      to: input.email,
      subject: `Demain : ${input.offerTitle}`,
      body: `Rappel : ${input.offerTitle} chez ${input.venueName}, ${input.whenLabel}.`,
    });
  }

  /**
   * Sending must never propagate into the caller's transaction. A failed email is
   * a logged incident, not a failed booking.
   */
  private async safeSend(message: EmailMessage): Promise<void> {
    try {
      await this.email.send(message);
    } catch (error) {
      this.logger.error(
        { err: error, to: message.to, subject: message.subject },
        'failed to send email; will be retried by the queue',
      );
    }
  }

  fromAddress(): string {
    return this.config.EMAIL_FROM;
  }
}
