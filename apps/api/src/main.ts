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

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    // The ingress terminates TLS and sets X-Forwarded-For; without this the
    // rate limiter would see every request as coming from the proxy.
    trustProxy: true,
    bodyLimit: 1_048_576,
    // Nest does its own request logging through RequestContextMiddleware.
    logger: false,
  });

  /**
   * Stripe signs the exact bytes it sent, so the webhook route needs the raw
   * body. Capturing it only for that route keeps every other endpoint on the
   * normal parsed-JSON path.
   */
  adapter.getInstance().addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      if (request.url.includes('/webhooks/')) {
        (request as { rawBody?: Buffer }).rawBody = body;
      }
      try {
        done(null, body.length > 0 ? JSON.parse(body.toString('utf8')) : {});
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  const config = app.get<AppConfig>(CONFIG);
  const logger = app.get<Logger>(LOGGER);

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

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
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
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
