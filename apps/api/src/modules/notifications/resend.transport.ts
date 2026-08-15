import type { AppConfig } from '@try/config';
import type { Logger } from '@try/logger';
import type { EmailMessage, EmailTransport } from './notification.service.js';

/** Un envoi bloqué plus longtemps que ça est un envoi perdu ; l'appelant réessaiera. */
const TIMEOUT_MS = 10_000;

/**
 * Envoi réel via Resend.
 *
 * Appel HTTP direct plutôt que le SDK : une requête POST vers un point d'entrée,
 * ce n'est pas une dépendance de plus à suivre, à auditer et à mettre à jour. Le
 * jour où il faut changer de fournisseur, c'est ce fichier et rien d'autre.
 *
 * Ce transport existe parce que la configuration EXIGE déjà `RESEND_API_KEY`
 * hors du développement local. Sans lui, cette exigence était un mensonge : la
 * clé était réclamée au démarrage puis jamais utilisée, et les codes de connexion
 * de vrais utilisateurs seraient partis dans les journaux.
 */
export class ResendEmailTransport implements EmailTransport {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    // Le corps ni le sujet ne sont journalisés : ils contiennent le code de
    // connexion à usage unique et le lieu où quelqu'un s'entraîne.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.RESEND_API_KEY ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.EMAIL_FROM,
          to: [message.to],
          subject: message.subject,
          text: message.body,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Le corps de la réponse d'erreur du fournisseur ne contient pas nos
        // données, seulement son diagnostic : il est utile et sans risque.
        const detail = await response.text().catch(() => '');
        throw new Error(`resend responded ${response.status}: ${detail.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
