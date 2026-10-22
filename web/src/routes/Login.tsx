import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Gamepad2, KeyRound, Eye, EyeOff } from "lucide-react";
import {
  Input,
  Label,
  Button,
  Alert,
  Spinner,
} from "@heroui/react";
import { APIError } from "@/lib/api";
import { Auth } from "@/lib/endpoints";
import { enforceUnauthenticatedTheme } from "@/lib/enforceUnauthenticatedTheme";
import { SAFE_MODE_SESSION_KEY } from "@/lib/useThemePreferences";
import { CompactLanguagePicker } from "@/components/settings/CompactLanguagePicker";
import { TurnstileWidget } from "@/components/TurnstileWidget";
import type { LoginProvider } from "@/types";
import { useOptionalIntl } from "@/lib/i18n/format";

// IMPORTANT: This pre-auth surface must not display any internal
// cluster metrics, server counts, hostnames, or version strings.
export function LoginPage() {
  const intl = useOptionalIntl();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Enabled login methods, fetched pre-auth. null = not loaded (failed or
  // pending) — the password form stays visible then, so a failed/slow
  // fetch never blocks sign-in.
  const [providers, setProviders] = useState<LoginProvider[] | null>(null);
  // Self-service reset isn't wired up (admins reset via the CLI), so "Forgot?"
  // just reveals an inline hint rather than linking to a non-existent flow.
  const [forgot, setForgot] = useState(false);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaAttempt, setCaptchaAttempt] = useState(0);

  // Unauthenticated surfaces always render the Pink preset with no custom
  // CSS (FR-011): pin the DOM for the route's lifetime so theme prefs cached
  // by a previous session on this browser can never leak onto /login.
  useEffect(() => enforceUnauthenticatedTheme(), []);

  useEffect(() => {
    let active = true;
    void Auth.providers()
      .then((r) => {
        if (active) setProviders(r.providers);
      })
      .catch(() => {
        /* local-only fallback — leave providers null */
      });
    void Auth.turnstile()
      .then((r) => {
        if (active) setSiteKey(r.siteKey || null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Shared by the form submit and the safe-mode link below the form: the
  // same credentials flow, but the safe-mode variant plants the session
  // flag before navigating so the authenticated session starts with the
  // custom CSS overlay suspended (contracts/theme-ui.md §1.3).
  const login = async (safe: boolean) => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      const { user } = await Auth.login({ username: u, password: p }, captchaToken ?? undefined);
      // Seed the identity cache so the app shell renders the real user on
      // first paint — no post-reload "guest" flash, no second /users/me fetch.
      queryClient.setQueryData(["me"], user);
      if (safe) {
        try {
          window.sessionStorage.setItem(SAFE_MODE_SESSION_KEY, "1");
        } catch {
          // sessionStorage blocked — sign-in still proceeds, just without
          // the safe-mode flag carried into the session.
        }
      }
      await navigate({ to: "/" });
    } catch (e) {
      setErr(errorMessage(e));
      if (siteKey) {
        setCaptchaToken(null);
        setCaptchaAttempt((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  const errorMessage = (e: unknown) => {
    if (e instanceof APIError && e.messageId === "server.auth.captcha_failed")
      return intl.formatMessage({ id: "web.routes.login.captcha_failed", defaultMessage: "Human verification failed. Please try again.", description: "Login: error shown when the Cloudflare Turnstile check on the sign-in form is rejected or expired" });
    if (e instanceof APIError)
      return intl.formatMessage({ id: "web.routes.login.invalid_credentials", defaultMessage: "Invalid credentials", description: "Login: error shown when the username or password is rejected; deliberately generic" });
    return intl.formatMessage({ id: "web.routes.login.network_error", defaultMessage: "Network error", description: "Login: error shown when the sign-in request could not reach the server" });
  };

  // One button per enabled SSO provider; the password form renders unless
  // the server explicitly reports local login disabled.
  const sso = providers?.filter((x) => x.kind !== "local") ?? [];
  const localEnabled = providers === null || providers.some((x) => x.kind === "local");
  const captchaPending = siteKey !== null && captchaToken === null;

  return (
    <div className="flex min-h-full flex-col bg-background px-4 py-6 sm:px-12 sm:py-8">
      <header className="flex justify-end">
        <CompactLanguagePicker />
      </header>

      <main className="flex flex-1 items-center justify-center py-10">
        <div className="w-full max-w-[460px] space-y-5 rounded-2xl border border-border bg-surface p-6 sm:p-10">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent text-accent-foreground">
              <Gamepad2 className="h-5 w-5" />
            </div>
            <div className="font-mono text-lg font-bold">{intl.formatMessage({ id: "web.routes.login.gameplane", defaultMessage: "gameplane", description: "Login: product name shown next to the logo at the top of the sign-in page; a brand name, usually kept as is" })}</div>
          </div>

          <div className="space-y-2 pb-2">
            <h1 className="text-[30px] font-bold leading-tight">{intl.formatMessage({ id: "web.routes.login.welcome_back", defaultMessage: "Welcome back", description: "Login: main heading of the sign-in card" })}</h1>
            <p className="text-[15px] text-muted">{intl.formatMessage({ id: "web.routes.login.sign_in_to_manage", defaultMessage: "Sign in to manage your game servers.", description: "Login: line under the sign-in heading explaining what signing in is for" })}</p>
          </div>

          {localEnabled ? (
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                void login(false);
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="username" className="text-[13px] font-medium">{intl.formatMessage({ id: "web.routes.login.email_or_username", defaultMessage: "Email or username", description: "Login: label of the username field on the sign-in form; the field accepts an email address or a username" })}</Label>
                <Input
                  id="username"
                  name="username"
                  value={u}
                  onChange={(e) => setU(e.target.value)}
                  autoFocus
                  autoComplete="username"
                  fullWidth
                  className="h-11"
                />
              </div>

              <div className="space-y-2">
                {/* The "Forgot?" control must sit OUTSIDE the <label>: a <label>
                    that wraps a second interactive element steals that element's
                    accessible name and mis-associates the field, so screen
                    readers (and tests) resolve the label to the button, not the
                    password input. */}
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-[13px] font-medium">{intl.formatMessage({ id: "web.routes.login.password", defaultMessage: "Password", description: "Login: label of the password field on the sign-in form" })}</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto min-w-0 p-0 text-[13px] font-medium text-accent hover:bg-transparent hover:text-accent/80"
                    onPress={() => setForgot((v) => !v)}
                  >{intl.formatMessage({ id: "web.routes.login.forgot_password", defaultMessage: "Forgot password?", description: "Login: small link beside the password label that shows the password-reset hint; keep it short" })}</Button>
                </div>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    value={p}
                    onChange={(e) => setP(e.target.value)}
                    autoComplete="current-password"
                    fullWidth
                    className="h-11 pr-10"
                  />
                  <Button
                    isIconOnly
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={showPassword ? intl.formatMessage({ id: "web.routes.login.hide_password", defaultMessage: "Hide password", description: "Login: aria-label of the button that hides the password" }) : intl.formatMessage({ id: "web.routes.login.show_password", defaultMessage: "Show password", description: "Login: aria-label of the button that reveals the password" })}
                    onPress={() => setShowPassword(!showPassword)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-muted"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                {forgot && (
                  <p className="text-xs text-muted">{intl.formatMessage({ id: "web.routes.login.contact_your_administrator_to_reset", defaultMessage: "Contact your administrator to reset your password.", description: "Login: hint shown under the password field after the forgot button is pressed, telling the user to ask an administrator to reset the password" })}</p>
                )}
              </div>

              {siteKey && <TurnstileWidget key={captchaAttempt} siteKey={siteKey} onToken={setCaptchaToken} />}

              {err && (
                <Alert
                  role="alert"
                  status="danger"
                  className="px-0 py-1 text-sm text-danger bg-transparent border-none"
                >
                  {err}
                </Alert>
              )}

              <Button
                type="submit"
                isDisabled={busy || captchaPending}
                variant="primary"
                size="lg"
                fullWidth
                className="h-[46px] rounded-lg font-semibold"
              >
                {busy && <Spinner size="sm" color="current" className="mr-2" />}{intl.formatMessage({ id: "web.routes.login.sign_in", defaultMessage: "Sign in", description: "Login: main submit button of the sign-in form; a spinner shows while the sign-in runs; keep it short" })}</Button>

              {sso.length > 0 && <OrDivider />}

              <SSOButtons providers={sso} />

              {/* Safe-mode entry point (contracts/theme-ui.md §1.3): same
                  credentials flow, but the session lands with the custom CSS
                  overlay suspended. href is the post-login destination; the
                  click runs the sign-in flow. */}
              <p className="text-xs text-muted">
                {intl.formatMessage({ id: "web.routes.login.trouble_with_custom_styling", defaultMessage: "Trouble with custom styling?", description: "Login: muted lead-in before the safe-mode sign-in link below the form" })}
                <a
                  href="/"
                  onClick={(e) => {
                    e.preventDefault();
                    if (!captchaPending) void login(true);
                  }}
                  className="ml-1 text-accent hover:text-accent/80"
                >{intl.formatMessage({ id: "web.routes.login.sign_in_with_safe_mode", defaultMessage: "Sign in with safe mode", description: "Login: link below the sign-in form that signs in with safe mode, which turns off custom styling" })}</a>
              </p>
            </form>
          ) : (
            <div className="space-y-4">
              <SSOButtons providers={sso} />
            </div>
          )}
        </div>
      </main>

      <footer className="flex flex-wrap items-center justify-center gap-2 text-center text-xs text-muted">
        <span>{intl.formatMessage({ id: "web.routes.login.need_access", defaultMessage: "Need access? Ask your administrator.", description: "Login: footer hint telling people without an account to ask an administrator" })}</span>
        <span aria-hidden="true">{intl.formatMessage({ id: "web.common.separator_dot", defaultMessage: "·", description: "Visual separator between two items" })}</span>
        <span>{intl.formatMessage({ id: "web.routes.login.agpl_3_0_licensed", defaultMessage: "AGPL-3.0 licensed", description: "Login: footer line below the sign-in form stating the license; AGPL-3.0 is the license name, a technical term usually left untranslated" })}</span>
      </footer>
    </div>
  );
}

function OrDivider() {
  const intl = useOptionalIntl();
  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <span className="h-px flex-1 bg-border" />
      {intl.formatMessage({ id: "web.routes.login.or", defaultMessage: "or", description: "Login: small word between the sign-in form and the single sign-on buttons; keep it short" })}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// One "Continue with …" button per enabled SSO provider. Labels come
// from the pre-auth providers endpoint (admin display names — never
// issuer URLs, per the login-privacy rule).
function SSOButtons({ providers }: { providers: LoginProvider[] }) {
  const intl = useOptionalIntl();
  return (
    <>
      {providers.map((p) => (
        <Button
          key={p.name ?? p.label}
          type="button"
          variant="outline"
          fullWidth
          className="h-11 rounded-lg font-medium"
          onPress={() => location.assign(Auth.oidcStartURL(p.name))}
        >
          <KeyRound className="h-4 w-4" />{intl.formatMessage({ id: "web.routes.login.continue_with_label", defaultMessage: "Continue with {label}", description: "Login: sentence with label in Button" }, { label: p.label })}</Button>
      ))}
    </>
  );
}
