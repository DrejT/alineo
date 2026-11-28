// Sign in with Google: the OAuth 2.0 authorization code flow with PKCE, run by this server.
//
//   GET /api/auth/google/start     redirects the browser to Google's consent screen
//   GET /api/auth/google/callback  Google redirects back here with a code. The server exchanges it,
//                                  finds or creates the user, and issues a normal dashboard session.
//
// The session token goes back to the SPA in the URL fragment (`/#auth_token=...`). A fragment is
// never sent to a server, so the token stays out of Caddy and access logs.
//
// Env:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  a "Web application" OAuth client. Unset turns the feature off.
//   ALINEO_UI_PUBLIC_URL                    the URL a browser uses for this dashboard, e.g.
//                                           https://app.alineo.tech. The redirect URI is
//                                           <this>/api/auth/google/callback and must be listed on the
//                                           OAuth client. Unset: built from the request's forwarded headers.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { createSession } from "./auth";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
export const GOOGLE_ENABLED = CLIENT_ID !== "" && CLIENT_SECRET !== "";

const COOKIE = "aln_google_oauth";
const COOKIE_PATH = "/api/auth/google";
const STATE_TTL_S = 600;

const b64url = (buf: Buffer) => buf.toString("base64url");

function publicBase(req: Request): string {
  const configured = process.env.ALINEO_UI_PUBLIC_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

const redirectUri = (req: Request) => `${publicBase(req)}${COOKIE_PATH}/callback`;

function cookie(req: Request, value: string, maxAge: number): string {
  const secure = publicBase(req).startsWith("https://") ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function readCookie(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

/** Back to the SPA with an error it can show on the login screen. */
function fail(req: Request, message: string): Response {
  return redirect(`${publicBase(req)}/#auth_error=${encodeURIComponent(message)}`, cookie(req, "", 0));
}

export function googleStart(req: Request): Response {
  if (!GOOGLE_ENABLED) return fail(req, "Google sign-in is not configured on this server");
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, cookie(req, `${state}.${verifier}`, STATE_TTL_S));
}

interface GoogleClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export async function googleCallback(req: Request): Promise<Response> {
  if (!GOOGLE_ENABLED) return fail(req, "Google sign-in is not configured on this server");
  const url = new URL(req.url);
  if (url.searchParams.get("error")) return fail(req, "Google sign-in was cancelled");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const [savedState, verifier] = (readCookie(req) ?? "").split(".");
  if (!code || !savedState || !verifier || state.length !== savedState.length
      || !timingSafeEqual(Buffer.from(state), Buffer.from(savedState))) {
    return fail(req, "Google sign-in expired. Try again.");
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) return fail(req, "Google did not accept the sign-in. Try again.");
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  if (!id_token) return fail(req, "Google returned no identity");

  // The ID token came straight from Google's token endpoint over TLS, so its signature does not need
  // checking here (OpenID Connect Core 3.1.3.7). The claims still do.
  let claims: GoogleClaims;
  try {
    claims = JSON.parse(Buffer.from(id_token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return fail(req, "Google returned an unreadable identity");
  }
  const issOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!issOk || claims.aud !== CLIENT_ID || !claims.sub || claims.exp * 1000 < Date.now()) {
    return fail(req, "Google returned an identity for another app");
  }
  if (!claims.email || claims.email_verified !== true) {
    return fail(req, "Your Google account has no verified email");
  }

  const userId = findOrCreateGoogleUser(claims.sub, claims.email.toLowerCase(), claims.name);
  const { token } = createSession(userId);
  return redirect(`${publicBase(req)}/#auth_token=${encodeURIComponent(token)}`, cookie(req, "", 0));
}

function findOrCreateGoogleUser(sub: string, email: string, name?: string): string {
  const bySub = db.query(`SELECT id FROM users WHERE google_sub = ?`).get(sub) as { id: string } | null;
  if (bySub) return bySub.id;

  // Google has verified this email, so an existing account with it is the same person. Link it.
  const byEmail = db.query(`SELECT id FROM users WHERE lower(email) = ?`).get(email) as { id: string } | null;
  if (byEmail) {
    db.prepare(`UPDATE users SET google_sub = ? WHERE id = ?`).run(sub, byEmail.id);
    return byEmail.id;
  }

  const userId = "usr_" + randomBytes(6).toString("hex");
  const username = freeUsername(email.split("@")[0] ?? "user");
  // No password: a random value no one knows, so the password login can never match it.
  const passwordHash = "oauth:" + randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO users (id, username, email, password_hash, display_name, created_at, google_sub)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, username, email, passwordHash, name?.trim() || username, Date.now(), sub);
  return userId;
}

function freeUsername(raw: string): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 24) || "user";
  const padded = base.length < 2 ? `${base}user` : base;
  const taken = (u: string) => db.query(`SELECT 1 FROM users WHERE username = ?`).get(u) !== null;
  if (!taken(padded)) return padded;
  for (let i = 0; i < 20; i++) {
    const candidate = `${padded}-${randomBytes(2).toString("hex")}`;
    if (!taken(candidate)) return candidate;
  }
  return `${padded}-${randomBytes(4).toString("hex")}`;
}
