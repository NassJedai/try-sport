import 'reflect-metadata';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { AppConfig } from '@try/config';
import type { Logger } from '@try/logger';
import { AppModule } from './app.module.js';
import { CONFIG } from './common/config.module.js';
import { LOGGER } from './common/logger.module.js';
import { loadEnvFiles } from './common/load-env.js';

async function bootstrap(): Promise<void> {
  /**
   * Before anything else: CONFIG is produced by a factory that Nest invokes
   * during `NestFactory.create`, and that factory validates and throws. Loading
   * .env any later would mean the process refuses to start with a perfectly
   * good .env sitting next to it.
   */
  loadEnvFiles();

  const adapter = new FastifyAdapter({
    // The ingress terminates TLS and sets X-Forwarded-For; without this the
    // rate limiter would see every request as coming from the proxy.
    trustProxy: true,
    bodyLimit: 1_048_576,
    // Nest does its own request logging through RequestContextMiddleware.
    logger: false,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
    /**
     * Stripe signs the exact bytes it sent, so the webhook handler must verify
     * against the raw body rather than a re-serialised object.
     *
     * Nest's own `rawBody` option is used instead of registering a custom
     * content-type parser: Fastify installs its JSON parser when the instance is
     * created, and adding a second one for the same type throws
     * FST_ERR_CTP_ALREADY_PRESENT at boot.
     */
    rawBody: true,
  });

  const config = app.get<AppConfig>(CONFIG);
  const logger = app.get<Logger>(LOGGER);

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  /**
   * Les uploads de photos arrivent en binaire brut, pas en multipart : un
   * fichier par requête, zéro dépendance de parsing. La limite de 9 Mo dépasse
   * légèrement la limite métier (8 Mo, vérifiée dans MediaService) pour que le
   * refus soit une erreur de validation propre, pas une coupure de connexion.
   */
  adapter
    .getInstance()
    .addContentTypeParser(
      ['image/jpeg', 'image/png', 'image/webp'],
      { parseAs: 'buffer', bodyLimit: 9 * 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );

  await app.register(helmet, {
    // The API serves JSON, not documents; CSP belongs on the web apps.
    contentSecurityPolicy: false,
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  /**
   * Explicit origin allowlist. A wildcard with credentials is refused by
   * browsers anyway, and configuration rejects "*" outside local development.
   */
  app.enableCors({
    origin: config.CORS_ALLOWED_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    /**
     * Must list every header the clients actually send. `X-Client` is set by
     * @try/api-client for diagnostics, and omitting it here failed the CORS
     * preflight for *every* browser request — the web apps could not reach the
     * API at all. Kept in sync with ApiClient's header construction.
     */
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Client',
    ],
    exposedHeaders: ['X-Request-Id', 'X-RateLimit-Remaining', 'Retry-After'],
    maxAge: 86_400,
  });

  // Lets Kubernetes/Fly drain in-flight requests before the process exits.
  app.enableShutdownHooks();

  if (!config.isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('TRY API')
        .setDescription('Sports discovery marketplace')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  logger.info(
    { port: config.PORT, environment: config.APP_ENV },
    `TRY API listening on :${config.PORT}`,
  );
}

bootstrap().catch((error: unknown) => {
  // Nothing is wired up yet at this point, so this is the one place console is right.
  console.error('Failed to start TRY API:', error);
  process.exit(1);
});
