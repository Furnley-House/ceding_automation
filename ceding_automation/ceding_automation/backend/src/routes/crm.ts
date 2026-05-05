// backend/src/routes/crm.ts
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as zoho from '../services/zohoCrm';

const router = Router();

const redirectUri = () =>
  process.env.ZOHO_REDIRECT_URI ?? 'http://localhost:3001/api/crm/oauth/callback';

// ── OAuth setup (one-time) ───────────────────────────────────
router.get('/oauth/authorize', (_req: Request, res: Response) => {
  res.redirect(zoho.buildAuthorizeUrl(redirectUri()));
});

router.get('/oauth/callback', async (req: Request, res: Response) => {
  const { code, error } = req.query as Record<string, string>;
  if (error || !code) {
    return res.status(400).send(`OAuth error: ${error ?? 'no code returned'}`);
  }
  try {
    const tokens = await zoho.exchangeCodeForTokens(code, redirectUri());
    const refreshToken = tokens.refresh_token as string | undefined;
    res.send(`
      <!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px">
        <h2>Zoho CRM connected</h2>
        <p>Copy this value into your <code>.env</code> as <code>ZOHO_REFRESH_TOKEN</code>:</p>
        <pre style="background:#f4f4f4;padding:12px;border-radius:4px;word-break:break-all">${refreshToken ?? 'Not returned — ensure access_type=offline was set'}</pre>
        <p style="color:#666;font-size:14px">Restart the server after updating <code>.env</code>. You only need to do this once.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${(err as Error).message}`);
  }
});

// ── Tasks ────────────────────────────────────────────────────
router.get('/tasks', requireAuth, async (req: Request, res: Response) => {
  try {
    const page = Number(req.query.page) || 1;
    const perPage = Math.min(Number(req.query.per_page) || 200, 200);
    const data = await zoho.listTasks(page, perPage);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/tasks/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await zoho.getTask(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.put('/tasks/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await zoho.updateTask(req.params.id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/tasks', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await zoho.createTask(req.body);
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as crmRoutes };
