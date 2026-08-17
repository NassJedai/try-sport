import { z } from 'zod';
import { BUSINESS_ROLES, SUPPORTED_LOCALES, USER_ROLES } from '../enums.js';
import { isoDateTimeSchema, uuidSchema } from './common.js';

export const emailSchema = z.email().max(254).toLowerCase().trim();

/** Step 1 of consumer login: request a one-time code. Always rate limited. */
export const requestOtpSchema = z.object({
  email: emailSchema,
  locale: z.enum(SUPPORTED_LOCALES).default('fr'),
});
export type RequestOtpDto = z.infer<typeof requestOtpSchema>;

export const verifyOtpSchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/),
  /** Optional attribution captured at first signup and preserved to first booking. */
  attribution: z
    .object({
      source: z.string().max(40).optional(),
      medium: z.string().max(40).optional(),
      campaign: z.string().max(80).optional(),
      content: z.string().max(80).optional(),
      term: z.string().max(80).optional(),
      referralCode: z.string().max(40).optional(),
      landingOfferId: uuidSchema.optional(),
      landingVenueId: uuidSchema.optional(),
    })
    .optional(),
});
export type VerifyOtpDto = z.infer<typeof verifyOtpSchema>;

/**
 * Connexion sociale. Le client transmet la preuve délivrée par le fournisseur ;
 * le serveur la vérifie lui-même. Un jeton décodé côté client n'est jamais cru —
 * c'est le serveur qui résout l'identité, comme il résout le prix.
 *
 * **`credential` est neutre exprès. Ne pas le « corriger » en `idToken`.**
 *
 * Le périmètre arbitré est Apple + Google, et tous deux émettent un jeton
 * d'identité signé, vérifiable hors ligne contre un JWKS. Mais Facebook —
 * reporté, pas exclu — émet un jeton d'accès *opaque*, qu'il faut échanger
 * contre l'API de Meta. `idToken` ne nommerait donc que l'un des deux mécanismes,
 * et le champ mentirait le jour où le second arrive. Renommer un champ de contrat
 * public coûte alors une propagation dans les quatre applications ; le nommer
 * juste maintenant, alors qu'aucun endpoint ne le consomme, ne coûte rien.
 *
 * Volontairement **plat plutôt qu'union discriminée sur `provider`** : les deux
 * branches d'aujourd'hui seraient structurellement identiques, donc l'union
 * n'ajouterait qu'un rétrécissement de type à faire chez l'appelant, sans porter
 * la moindre information. Elle deviendra le bon outil le jour où la *forme* de la
 * requête diverge réellement selon le fournisseur — un `nonce`, une URL de
 * redirection, un secret d'échange —, pas le jour où un fournisseur s'ajoute.
 *
 * Attention pour l'implémenteur : `packages/logger` masque `idToken` dans ses
 * `REDACTED_PATHS` et ne connaît pas `credential`. Ajouter `credential` et
 * `*.credential` à cette liste fait partie du branchement de l'endpoint, sinon un
 * corps de requête journalisé livre la preuve d'identité en clair.
 */
export const oauthLoginSchema = z.object({
  provider: z.enum(['GOOGLE', 'APPLE']),
  /** Jeton d'identité signé (Google, Apple) ou jeton d'accès opaque à échanger. */
  credential: z.string().min(20).max(8192),
  /** Apple ne renvoie le nom qu'à la toute première autorisation. */
  firstName: z.string().max(80).optional(),
  lastName: z.string().max(80).optional(),
});
export type OAuthLoginDto = z.infer<typeof oauthLoginSchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  /** Short-lived access token; the refresh token is rotated on every use. */
  expiresIn: z.int().positive(),
  refreshToken: z.string(),
});
export type AuthTokensDto = z.infer<typeof authTokensSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(20).max(1024),
});
export type RefreshTokenDto = z.infer<typeof refreshTokenSchema>;

export const notificationPreferencesSchema = z.object({
  bookingUpdates: z.boolean(),
  reminders: z.boolean(),
  recommendations: z.boolean(),
  marketing: z.boolean(),
});
export type NotificationPreferencesDto = z.infer<typeof notificationPreferencesSchema>;

export const viewerSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  locale: z.enum(SUPPORTED_LOCALES),
  roles: z.array(z.enum(USER_ROLES)),
  /** Business memberships; a single account can be both a consumer and staff. */
  businessMemberships: z.array(
    z.object({
      businessId: uuidSchema,
      businessName: z.string(),
      role: z.enum(BUSINESS_ROLES),
    }),
  ),
  interests: z.array(uuidSchema),
  onboardingCompletedAt: isoDateTimeSchema.nullable(),
  notificationPreferences: notificationPreferencesSchema,
  createdAt: isoDateTimeSchema,
});
export type ViewerDto = z.infer<typeof viewerSchema>;

export const authSessionSchema = z.object({
  tokens: authTokensSchema,
  viewer: viewerSchema,
  /** True when this call created the account, so the client can route to onboarding. */
  isNewUser: z.boolean(),
});
export type AuthSessionDto = z.infer<typeof authSessionSchema>;

export const completeOnboardingSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  interests: z.array(uuidSchema).min(1).max(20),
  locale: z.enum(SUPPORTED_LOCALES).optional(),
});
export type CompleteOnboardingDto = z.infer<typeof completeOnboardingSchema>;

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().max(80).nullable().optional(),
  locale: z.enum(SUPPORTED_LOCALES).optional(),
  interests: z.array(uuidSchema).max(20).optional(),
  notificationPreferences: notificationPreferencesSchema.partial().optional(),
});
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;

export const registerPushTokenSchema = z.object({
  token: z.string().min(10).max(512),
  platform: z.enum(['IOS', 'ANDROID', 'WEB']),
  deviceId: z.string().max(128).optional(),
});
export type RegisterPushTokenDto = z.infer<typeof registerPushTokenSchema>;
