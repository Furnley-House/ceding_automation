// backend/src/routes/auth.ts
import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const router = Router();
const prisma = new PrismaClient();

const frontendUrl = () => process.env.FRONTEND_URL ?? "http://localhost:5173";
const azureTenant = () => process.env.AZURE_TENANT_ID ?? "";
const azureClientId = () => process.env.AZURE_CLIENT_ID ?? "";
const azureClientSecret = () => process.env.AZURE_CLIENT_SECRET ?? "";
const azureRedirectUri = () =>
  process.env.AZURE_REDIRECT_URI ?? "http://localhost:3001/api/auth/azure/callback";

// Demo login (no password – role-selector for prototype, SSO in prod)
router.post("/login", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true, status: true },
  });

  if (!user || user.status === "INACTIVE") {
    return res.status(401).json({ error: "User not found or inactive" });
  }

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, {
    expiresIn: process.env.JWT_EXPIRES_IN || "8h",
  });

  res.json({ token, user });
});

router.get("/me", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, name: true, role: true },
    });
    res.json(user);
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

// ── Azure AD SSO ─────────────────────────────────────────────────────────────

// Step 1 — build the Microsoft login URL and redirect the browser there.
// `returnTo` carries the path the user was trying to reach (e.g. /cases?zohoTaskId=xxx)
// so we can send them straight there after sign-in.
router.get("/azure", (req: Request, res: Response) => {
  if (!azureTenant() || !azureClientId()) {
    return res.status(503).json({
      error:
        "Azure AD SSO not configured. Add AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_REDIRECT_URI to .env",
    });
  }

  const returnTo = (req.query.returnTo as string) || "/dashboard";
  // Encode returnTo inside `state` so Azure echoes it back untouched.
  const state = encodeURIComponent(JSON.stringify({ returnTo }));

  const params = new URLSearchParams({
    client_id: azureClientId(),
    response_type: "code",
    redirect_uri: azureRedirectUri(),
    response_mode: "query",
    scope: "openid profile email User.Read",
    state,
  });

  const authUrl = `https://login.microsoftonline.com/${azureTenant()}/oauth2/v2.0/authorize?${params.toString()}`;
  res.redirect(authUrl);
});

// Step 2 — Microsoft redirects here after sign-in.
// Exchange the code for tokens, look up the user by email, issue our JWT.
router.get("/azure/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  const fe = frontendUrl();

  if (error || !code) {
    const msg = encodeURIComponent(error_description ?? error ?? "Azure AD sign-in failed");
    return res.redirect(`${fe}/auth/callback?error=${msg}`);
  }

  // Decode returnTo from state
  let returnTo = "/dashboard";
  try {
    const stateData = JSON.parse(decodeURIComponent(state ?? "{}")) as { returnTo?: string };
    returnTo = stateData.returnTo ?? "/dashboard";
  } catch {
    // keep default
  }

  try {
    // Exchange authorisation code for tokens
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${azureTenant()}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: azureClientId(),
          client_secret: azureClientSecret(),
          code,
          redirect_uri: azureRedirectUri(),
          grant_type: "authorization_code",
        }).toString(),
      }
    );

    const tokens = (await tokenRes.json()) as Record<string, unknown>;
    if (!tokens.id_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
    }

    // Decode id_token claims (we trust it — it came straight from Azure's token endpoint)
    const [, payloadB64] = (tokens.id_token as string).split(".");
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf-8")
    ) as Record<string, unknown>;

    // preferred_username is typically the UPN (email). Fall back to email claim.
    const email =
      ((payload.preferred_username ?? payload.email ?? payload.upn) as string | undefined)
        ?.toLowerCase()
        ?.trim() ?? "";

    if (!email) {
      throw new Error("Azure AD did not return an email address. Check the app registration scopes.");
    }

    // Look up our app user by email
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, role: true, status: true },
    });

    if (!user) {
      const msg = encodeURIComponent(
        `No account found for ${email}. Ask an admin to add you in the Ceding App.`
      );
      return res.redirect(`${fe}/auth/callback?error=${msg}`);
    }

    if (user.status === "INACTIVE") {
      const msg = encodeURIComponent("Your account is inactive. Contact an admin.");
      return res.redirect(`${fe}/auth/callback?error=${msg}`);
    }

    // Issue our own JWT
    const appToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, {
      expiresIn: process.env.JWT_EXPIRES_IN ?? "8h",
    });

    // Redirect to frontend callback page with all the info it needs
    const cbParams = new URLSearchParams({
      token: appToken,
      user: JSON.stringify({ id: user.id, email: user.email, name: user.name, role: user.role }),
      returnTo,
    });

    res.redirect(`${fe}/auth/callback?${cbParams.toString()}`);
  } catch (err) {
    const msg = encodeURIComponent((err as Error).message ?? "SSO failed");
    res.redirect(`${fe}/auth/callback?error=${msg}`);
  }
});

export { router as authRoutes };
