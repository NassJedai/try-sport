import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@try/logger';
import type { AppConfig } from '@try/config';
import type { Locale } from '@try/contracts';
import { CONFIG } from '../../common/config.module.js';
import { LOGGER } from '../../common/logger.module.js';

/**
 * Le titre d'un rappel, qui doit être vrai dans les trois cas de figure.
 *
 * Il vit ici, et non dans le service qui l'appelle, parce que `reminder.service`
 * importe déjà ce fichier : l'inverse fermerait un cycle entre les deux modules.
 * Exporté pour être testé seul — c'est une règle de langage, elle se vérifie
 * sans base de données.
 */
export function buildTitle(lead: 'day' | 'hours', isToday: boolean, offerTitle: string): string {
  if (lead === 'hours') return `Dans 2 h : ${offerTitle}`;
  return isToday ? `Aujourd'hui : ${offerTitle}` : `Demain : ${offerTitle}`;
}

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
 *
 * Digit runs in the subject are masked before logging: the OTP subject line is
 * "123456 — ton code de connexion", and logging it verbatim put a login
 * credential in the logs through a side door the redaction rules never saw.
 * (The deliberate dev affordance for reading the code is AUTH_DEV_ECHO_OTP.)
 */
@Injectable()
export class ConsoleEmailTransport implements EmailTransport {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  send(message: EmailMessage): Promise<void> {
    this.logger.info(
      { to: message.to, subject: message.subject.replace(/\d{4,}/g, '••••') },
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

  /**
   * Rappel avant séance.
   *
   * Les deux échéances ne disent pas la même chose : la veille, on peut encore
   * annuler et rendre la place à quelqu'un d'autre ; deux heures avant, il n'y a
   * plus qu'à venir. Le sujet doit donc suivre — « Demain » envoyé deux heures
   * avant le cours est faux, et un rappel faux est pire que pas de rappel.
   */
  async sendReminder(input: {
    email: string;
    offerTitle: string;
    venueName: string;
    whenLabel: string;
    lead: 'day' | 'hours';
    /** Vrai si la séance tombe le jour même dans le fuseau du LIEU. */
    isToday: boolean;
  }): Promise<void> {
    const isDayBefore = input.lead === 'day';

    await this.safeSend({
      to: input.email,
      subject: buildTitle(input.lead, input.isToday, input.offerTitle),
      body: [
        `${input.offerTitle} chez ${input.venueName}, ${input.whenLabel}.`,
        isDayBefore
          ? `Un empêchement ? Annule depuis l'app pour libérer ta place — quelqu'un d'autre la prendra.`
          : `Pense à ton QR code, il est dans l'app.`,
      ].join('\n\n'),
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
