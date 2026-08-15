import type { NextConfig } from 'next';

const isDevelopment = process.env.NODE_ENV !== 'production';

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source rather than build output, so Next
  // compiles them as part of the app.
  transpilePackages: ['@try/api-client', '@try/contracts', '@try/design-tokens', '@try/utils'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            // The dashboard renders no third-party content; a strict CSP costs
            // nothing here and removes a whole class of injection.
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              /**
               * React's development build uses eval() to reconstruct call stacks
               * for its debugging overlay. Allowing it in dev only keeps the
               * production policy strict, where React never uses eval at all.
               */
              `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ''}`,
              "style-src 'self' 'unsafe-inline'",
              /**
               * En dev, les photos sont servies par l'API locale en http —
               * localhost ou l'IP du réseau selon l'appareil. En production,
               * https: seul reste autorisé.
               */
              `img-src 'self' data: https:${isDevelopment ? ' http://localhost:3000 http://192.168.0.8:3000' : ''}`,
              "connect-src 'self' http://localhost:3000 https://api.try.be",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default config;
