// backend/src/routes/crm.ts
import { Router, Request, Response } from 'express';
import { PrismaClient, CaseStatus, PlanType, Prisma } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import * as zoho from '../services/zohoCrm';
import { mapZohoTaskToCase, lookupParaplannerFromContact } from '../services/zohoCrm';
import { generateNextCaseRef } from '../services/caseRef';

const router = Router();
const prisma = new PrismaClient();

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

// ── Import a Zoho task as a Case ────────────────────────────
// Pass ?dryRun=true to preview the mapping without writing to the DB.
// If a case with the same zohoTaskId already exists, return it instead of duplicating.
router.post('/tasks/:id/import-as-case', requireAuth, async (req: Request, res: Response) => {
  const taskId = req.params.id;
  const dryRun = String(req.query.dryRun ?? '') === 'true';

  try {
    // 1. Fetch the task from Zoho
    const raw = (await zoho.getTask(taskId)) as { data?: unknown[] };
    const taskRecord = Array.isArray(raw?.data) ? (raw.data[0] as Record<string, unknown>) : null;
    if (!taskRecord) {
      return res.status(404).json({ error: 'Zoho task not found', raw });
    }

    // 2. Map the task fields → Case fields (best-effort, configurable via env)
    const mapping = mapZohoTaskToCase(taskRecord);

    // 3. Look up provider by name; create a bare record if none found so the name is never lost.
    let providerId: string | undefined;
    if (mapping.providerName) {
      let provider = await prisma.provider.findFirst({
        where: { name: { equals: mapping.providerName, mode: 'insensitive' } },
      });
      if (!provider) {
        provider = await prisma.provider.create({ data: { name: mapping.providerName } });
      }
      providerId = provider.id;
    }

    // 4. Resolve the Zoho task's Owner to an app user, by email first then by name.
    //    If no match, fall back to the importer (req.user). This preserves Zoho's
    //    "task ownership" inside our app so the CA who clicked through from CRM
    //    sees the case as assigned to themselves.
    let assignedAppUserId = req.user!.id;
    let ownerResolution: 'email' | 'name' | 'fallback-caller' = 'fallback-caller';
    if (mapping.ownerEmail) {
      const byEmail = await prisma.user.findUnique({
        where: { email: mapping.ownerEmail.toLowerCase() },
      });
      if (byEmail && byEmail.status === 'ACTIVE') {
        assignedAppUserId = byEmail.id;
        ownerResolution = 'email';
      }
    }
    if (ownerResolution === 'fallback-caller' && mapping.ownerName) {
      const byName = await prisma.user.findFirst({
        where: { name: { equals: mapping.ownerName, mode: 'insensitive' }, status: 'ACTIVE' },
      });
      if (byName) {
        assignedAppUserId = byName.id;
        ownerResolution = 'name';
      }
    }

    // 4b. Resolve the paraplanner from the linked Contact (client) record.
    //     For UAT: the Contact has a custom "Paraplanner" field — we read it,
    //     match the value to an active app user (by email then by name).
    //     For testing: when the Contact has no paraplanner set OR the lookup
    //     fails (e.g. missing scope), fall back to the first PARAPLANNER user
    //     in the system (Megan Doherty in the demo seed).
    let paralPlannerId: string | null = null;
    let paraplannerResolution:
      | 'contact-email'
      | 'contact-name'
      | 'fallback-first-paraplanner'
      | 'none' = 'none';
    if (mapping.clientZohoId) {
      try {
        const pp = await lookupParaplannerFromContact(mapping.clientZohoId);
        if (pp?.email) {
          const u = await prisma.user.findUnique({ where: { email: pp.email.toLowerCase() } });
          if (u && u.status === 'ACTIVE' && u.role === 'PARAPLANNER') {
            paralPlannerId = u.id;
            paraplannerResolution = 'contact-email';
          }
        }
        if (!paralPlannerId && pp?.name) {
          const u = await prisma.user.findFirst({
            where: {
              name: { equals: pp.name, mode: 'insensitive' },
              status: 'ACTIVE',
              role: 'PARAPLANNER',
            },
          });
          if (u) {
            paralPlannerId = u.id;
            paraplannerResolution = 'contact-name';
          }
        }
      } catch (err) {
        // Contact lookup failed (likely a missing OAuth scope or the contact
        // doesn't exist). Don't block the import — fall through to the
        // Emma-Clarke fallback below.
        // eslint-disable-next-line no-console
        console.warn(`Paraplanner lookup from Contact failed: ${(err as Error).message}`);
      }
    }
    if (!paralPlannerId) {
      const fallback = await prisma.user.findFirst({
        where: { role: 'PARAPLANNER', status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      });
      if (fallback) {
        paralPlannerId = fallback.id;
        paraplannerResolution = 'fallback-first-paraplanner';
      }
    }

    // 5. Re-use existing case if this Zoho task was already imported
    const existing = await prisma.case.findFirst({
      where: { zohoTaskId: taskId },
      include: { provider: true },
    });
    if (existing) {
      // Backfill any blank fields that Zoho now provides
      const patches: Record<string, unknown> = {};
      if (!existing.providerId && providerId) patches.providerId = providerId;
      if (!existing.policyRef && mapping.policyRef) patches.policyRef = mapping.policyRef;
      if (!existing.zohoDeepLink && mapping.zohoDeepLink) patches.zohoDeepLink = mapping.zohoDeepLink;
      if (!existing.paralPlannerId && paralPlannerId) patches.paralPlannerId = paralPlannerId;

      if (Object.keys(patches).length > 0) {
        const updated = await prisma.case.update({
          where: { id: existing.id },
          data: patches,
          include: { provider: true, createdBy: true, assignedTo: true },
        });
        return res.json({
          case: updated,
          mapping,
          zohoTask: taskRecord,
          message: 'Case already exists — missing fields backfilled',
          alreadyExisted: true,
        });
      }
      return res.json({
        case: existing,
        mapping,
        zohoTask: taskRecord,
        message: 'Case already exists for this Zoho task',
        alreadyExisted: true,
      });
    }

    if (dryRun) {
      return res.json({
        dryRun: true,
        mapping,
        providerResolvedId: providerId ?? null,
        assignedAppUserId,
        ownerResolution,
        paralPlannerId,
        paraplannerResolution,
        zohoTask: taskRecord,
      });
    }

    // 6. Create the case — caseRef via the shared helper (services/caseRef.ts)
    // so this path uses the same max-suffix logic as the manual new-case form
    // (avoids count-based collisions when prior cases have been deleted).
    const caseRef = await generateNextCaseRef(prisma);

    const newCase = await prisma.case.create({
      data: {
        caseRef,
        clientName: mapping.clientName || `Imported task ${taskId}`,
        clientZohoId: mapping.clientZohoId ?? null,
        planType: mapping.planType,
        policyRef: mapping.policyRef ?? null,
        providerId: providerId ?? null,
        zohoTaskId: taskId,
        zohoCaseId: mapping.zohoCaseId ?? null,
        zohoDeepLink: mapping.zohoDeepLink ?? null,
        createdById: req.user!.id,            // who triggered the import
        assignedToId: assignedAppUserId,      // who owns the work (matches Zoho)
        paralPlannerId: paralPlannerId,       // paraplanner pulled from Contact (or fallback)
        status: CaseStatus.STAGE_1_LOA_PREP,
      },
      include: { provider: true, createdBy: true, assignedTo: true, paraplanner: true },
    });

    // 7. Initialise checklist fields from active templates
    const templates = await prisma.checklistTemplate.findMany({
      where: { planType: mapping.planType, isActive: true },
    });
    if (templates.length > 0) {
      await prisma.checklistField.createMany({
        data: templates.map((t) => ({ caseId: newCase.id, templateId: t.id })),
      });
    }

    // 8. Audit log
    await prisma.auditLog.create({
      data: {
        caseId: newCase.id,
        userId: req.user!.id,
        action: 'CASE_CREATED',
        source: 'SYSTEM',
        newValue: `Imported from Zoho task ${taskId}`,
        metadata: {
          zohoTaskId: taskId,
          mapping,
          ownerResolution,
          assignedAppUserId,
          paraplannerResolution,
          paralPlannerId,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    res.status(201).json({
      case: newCase,
      mapping,
      zohoTask: taskRecord,
      ownerResolution,
      paraplannerResolution,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as crmRoutes };
