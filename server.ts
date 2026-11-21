import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getOrchestratorAgentCard } from './server/a2a/protocol.ts';
import { ENV } from './server/config/env.ts';
import { telemetry } from './server/observability/telemetry.ts';
import { createApiRouter } from './server/routes/api.ts';
import { attachLiveVoiceGateway } from './server/voice/live-gateway.ts';

async function bootstrap() {
  const app = express();
  app.set('trust proxy', 1);

  // Security headers
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  // A2A Discovery Well-Known Agent Card
  app.get('/.well-known/agent.json', (req: Request, res: Response) => {
    const baseUrl = `${req.protocol}://${req.get('host') ?? `localhost:${ENV.PORT}`}`;
    res.json(getOrchestratorAgentCard(baseUrl));
  });

  // Backend API Routes
  app.use('/api', createApiRouter());

  // Safe API error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    telemetry.log({
      severity: 'ERROR',
      component: 'http-server',
      event: 'unhandled_error',
      metadata: { message: err.message.slice(0, 120) },
    });
    res.status(500).json({ error: 'Internal server error.' });
  });

  const server = http.createServer(app);

  // Attach real-time Gemini Live WebSocket Gateway
  attachLiveVoiceGateway(server);

  if (ENV.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  server.listen(ENV.PORT, '0.0.0.0', () => {
    telemetry.log({
      severity: 'INFO',
      component: 'server',
      event: 'listening',
      metadata: { port: ENV.PORT, mode: ENV.NODE_ENV },
    });
  });
}

bootstrap().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
