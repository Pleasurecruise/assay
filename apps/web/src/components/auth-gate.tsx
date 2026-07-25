import { ArrowRight, Languages, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";

import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/i18n";

export function AuthGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const { language, setLanguage, t } = useI18n();
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [error, setError] = useState("");

  const toggleLanguage = () => {
    setLanguage(language === "en-US" ? "zh-CN" : "en-US");
  };

  const signIn = async () => {
    setIsRedirecting(true);
    setError("");
    const showSignInError = () => {
      setError(t("auth.error"));
      setIsRedirecting(false);
    };
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: window.location.href,
      });
      if (!result.error) {
        return;
      }
      showSignInError();
    } catch {
      showSignInError();
    }
  };

  if (isPending) {
    return (
      <main className="auth-screen auth-screen--loading">
        <span className="auth-loader" />
        <p>{t("auth.loading")}</p>
      </main>
    );
  }

  if (session?.user) {
    return children;
  }

  return (
    <main className="auth-screen">
      <button
        aria-label={t("language.label")}
        className="auth-language"
        onClick={toggleLanguage}
        type="button"
      >
        <Languages />
        {language === "en-US" ? t("language.zh") : t("language.en")}
      </button>
      <section className="auth-card">
        <div className="auth-card__mark">
          <ShieldCheck />
          <span>ASSAY / AUTH</span>
        </div>
        <p className="auth-card__eyebrow">{t("auth.eyebrow")}</p>
        <h1>{t("auth.title")}</h1>
        <p className="auth-card__body">{t("auth.body")}</p>
        <button
          className="google-sign-in"
          disabled={isRedirecting}
          onClick={() => void signIn()}
          type="button"
        >
          <GoogleMark />
          <span>{isRedirecting ? t("auth.redirecting") : t("auth.google")}</span>
          <ArrowRight />
        </button>
        {error ? <p className="auth-card__error">{error}</p> : null}
        <p className="auth-card__storage">{t("auth.sessionStored")}</p>
      </section>
      <span className="auth-coordinate auth-coordinate--left">{t("auth.identityMarker")}</span>
      <span className="auth-coordinate auth-coordinate--right">{t("auth.privateMarker")}</span>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M21.6 12.23c0-.71-.06-1.24-.2-1.79H12v3.4h5.52a4.7 4.7 0 0 1-2.05 3.08l-.02.11 2.98 2.31.2.02c1.83-1.7 2.97-4.19 2.97-7.13"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.69 0 4.94-.89 6.59-2.64l-3.16-2.44c-.85.57-1.98.97-3.43.97a5.96 5.96 0 0 1-5.64-4.12l-.1.01-3.1 2.4-.04.1A9.96 9.96 0 0 0 12 22"
        fill="#34A853"
      />
      <path
        d="M6.36 13.77A6.1 6.1 0 0 1 6.03 12c0-.62.11-1.21.32-1.77v-.12L3.2 7.67l-.1.05A10 10 0 0 0 2 12c0 1.54.35 3 1.12 4.28z"
        fill="#FBBC05"
      />
      <path
        d="M12 6.11c1.87 0 3.13.81 3.85 1.48l2.8-2.74A9.52 9.52 0 0 0 12 2a9.96 9.96 0 0 0-8.88 5.72l3.23 2.51A5.98 5.98 0 0 1 12 6.11"
        fill="#EB4335"
      />
    </svg>
  );
}
