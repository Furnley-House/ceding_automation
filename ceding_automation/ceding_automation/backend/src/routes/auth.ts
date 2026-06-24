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
    expiresIn: (process.env.JWT_EXPIRES_IN || "8h") as jwt.SignOptions["expiresIn"],
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
    // offline_access is required for Microsoft to return a refresh_token
    // in the code-exchange step. We persist that on the User row and use
    // it from POST /auth/refresh to silently mint new app JWTs.
    scope: "openid profile email offline_access User.Read",
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

    // Azure object id — stable per-user identifier we store on the user row
    // so admins can see at a glance who has signed in via SSO at least once.
    const azureOid = (payload.oid as string | undefined) ?? null;

    if (!email) {
      throw new Error("Azure AD did not return an email address. Check the app registration scopes.");
    }

    // Capture the Microsoft refresh_token so /auth/refresh can use it
    // later. Will be null if the user denied offline_access consent or the
    // app reg doesn't permit it.
    const msRefreshToken = (tokens.refresh_token as string | undefined) ?? null;

    // Look up our app user by email
    let user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, role: true, status: true, ssoId: true },
    });

    // Auto-provision on first sign-in.
    //
    // If Azure AD vouches for this email (i.e. the user successfully
    // authenticated against our tenant), we trust them as a Furnley House
    // member and create a baseline `CA_TEAM` account on the fly. Admins can
    // promote them to ADVISER / PARAPLANNER / ADMIN afterwards. The
    // AZURE_TENANT_ID env var is the gate that keeps this safe — only users
    // inside the configured directory can ever reach this branch.
    //
    // Without this, a CA whose Zoho task gets reassigned to a brand-new hire
    // would have no way to hand the case over until an admin manually creates
    // the new hire's row, which is exactly the friction we want to avoid.
    if (!user) {
      const displayName =
        ((payload.name as string | undefined) ??
          [payload.given_name, payload.family_name]
            .filter(Boolean)
            .join(" ")
            .trim() ??
          "")
          .trim() || email.split("@")[0];

      user = await prisma.user.create({
        data: {
          email,
          name: displayName,
          role: "CA_TEAM",
          status: "ACTIVE",
          ssoId: azureOid,
          ssoRefreshToken: msRefreshToken,
        },
        select: { id: true, email: true, name: true, role: true, status: true, ssoId: true },
      });
    } else if (user.status === "INACTIVE") {
      const msg = encodeURIComponent("Your account is inactive. Contact an admin.");
      return res.redirect(`${fe}/auth/callback?error=${msg}`);
    } else {
      // Existing user: refresh the stored Microsoft refresh_token (rotates
      // every sign-in) and backfill ssoId if missing. Non-blocking — if the
      // update fails (e.g. ssoId collision) we just skip it and the user
      // can still sign in.
      const updateData: Record<string, unknown> = {};
      if (msRefreshToken) updateData.ssoRefreshToken = msRefreshToken;
      if (azureOid && user.ssoId !== azureOid) updateData.ssoId = azureOid;
      if (Object.keys(updateData).length > 0) {
        try {
          await prisma.user.update({ where: { id: user.id }, data: updateData });
        } catch {
          /* non-blocking */
        }
      }
    }

    // Issue our own JWT
    const appToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, {
      expiresIn: (process.env.JWT_EXPIRES_IN ?? "8h") as jwt.SignOptions["expiresIn"],
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

// ── Silent token refresh ────────────────────────────────────────────────────
//
// When the app JWT expires the frontend's 401 interceptor calls here BEFORE
// dropping the user back to the SSO redirect. We accept a (possibly expired)
// JWT, decode the userId, use the user's stored Microsoft refresh_token to
// mint new Microsoft tokens, then issue a fresh app JWT.
//
// Replaces the old behaviour where any 401 mid-extraction kicked the user to
// the login screen and silently lost the in-flight task.
//
// Microsoft rotates the refresh_token on every use, so we persist the rotated
// one back to the user row. If Microsoft refuses the refresh (revoked /
// expired / consent withdrawn), the frontend falls through to full SSO.
router.post("/refresh", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });
  const token = authHeader.split(" ")[1];

  // Decode without enforcing expiry — the whole point is to refresh an
  // expired token. The signature check still ensures the token is one we
  // issued (so a random JWT can't trigger refreshes for arbitrary users).
  let userId: string;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!, {
      ignoreExpiration: true,
    }) as { userId: string };
    userId = decoded.userId;
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      ssoRefreshToken: true,
    },
  });
  if (!user) return res.status(401).json({ error: "User not found" });
  if (user.status === "INACTIVE") return res.status(401).json({ error: "User inactive" });
  if (!user.ssoRefreshToken) {
    // Pre-offline_access users have no stored refresh_token; they need to
    // do a full SSO round-trip to bootstrap one.
    return res.status(401).json({ error: "No refresh token on record — sign in again" });
  }

  // Use Microsoft refresh_token to get new tokens
  let msTokens: Record<string, unknown>;
  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${azureTenant()}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: azureClientId(),
          client_secret: azureClientSecret(),
          refresh_token: user.ssoRefreshToken,
          grant_type: "refresh_token",
          scope: "openid profile email offline_access User.Read",
        }).toString(),
      },
    );
    msTokens = (await tokenRes.json()) as Record<string, unknown>;
  } catch (err) {
    return res
      .status(502)
      .json({ error: `Microsoft refresh failed: ${(err as Error).message}` });
  }

  if (!msTokens.refresh_token || !msTokens.id_token) {
    // Microsoft refused — refresh_token was revoked / expired / consent
    // withdrawn. Wipe the stale token so we don't keep retrying it; force
    // the user through a full SSO round-trip.
    await prisma.user
      .update({ where: { id: user.id }, data: { ssoRefreshToken: null } })
      .catch(() => {});
    return res.status(401).json({
      error: "Microsoft refused refresh — sign in again",
      detail: msTokens.error ?? null,
    });
  }

  // Persist the rotated refresh_token. If this fails (race / concurrent
  // refresh) we still issue the new app JWT — the next /refresh will use
  // the most recently rotated token from whichever request raced ours.
  await prisma.user
    .update({
      where: { id: user.id },
      data: { ssoRefreshToken: msTokens.refresh_token as string },
    })
    .catch(() => {});

  // Issue new app JWT (same expiry as fresh sign-in)
  const appToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, {
    expiresIn: (process.env.JWT_EXPIRES_IN ?? "8h") as jwt.SignOptions["expiresIn"],
  });

  res.json({
    token: appToken,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

export { router as authRoutes };
