import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import type { ServerDatabase } from './server/postgres.ts';
import { getDb } from './server/db.ts';
import { createAuthRouter } from './server/routes/authRoutes.ts';
import { createAppRouter } from './server/routes/appRoutes.ts';
import { createEnterpriseRoutes } from './server/routes/enterpriseRoutes.ts';

export function createExpressApp(db: ServerDatabase) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    try {
      db.prepare('SELECT 1 AS healthy').get();
      res.json({ ok: true, service: 'SmartAttend', database: 'connected', timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({
        ok: false,
        service: 'SmartAttend',
        database: 'unavailable',
        error: err instanceof Error ? err.message : 'Database check failed.',
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.use('/api/auth', createAuthRouter(db));
  app.use('/api', createAppRouter(db));
  app.use('/api', createEnterpriseRoutes(db));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  return app;
}

async function startServer() {
  const db = getDb();
  const app = createExpressApp(db);
  const port = Number(process.env.PORT || 3000);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`SmartAttend server running on http://0.0.0.0:${port}`);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  startServer().catch((err) => {
    console.error('Failed to start SmartAttend server:', err);
    process.exit(1);
  });
}
