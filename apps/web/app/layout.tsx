import type { Metadata, Viewport } from "next";
import "@/styles/tokens.css";
import "./global.css";

export const metadata: Metadata = {
  title: "Agentic Operator",
  description: "Event-driven agentic workflow runtime",
};

export const viewport: Viewport = {
  width: 1440,
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-theme="dark"
      data-density="default"
      suppressHydrationWarning
    >
      <head>
        {/* No-flash: set theme/density/lang from localStorage before first
            paint, resolving `system` via the OS preference. Mutating <html>
            pre-hydration is why <html> carries suppressHydrationWarning. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=JSON.parse(localStorage.getItem('agentic.tweaks')||'{}');" +
              "var th=t.theme;if(th!=='light'&&th!=='dark'){th=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';}" +
              "var d=document.documentElement;d.setAttribute('data-theme',th);" +
              "if(t.density==='compact'||t.density==='comfortable'||t.density==='default'){d.setAttribute('data-density',t.density);}" +
              "if(t.language==='en'||t.language==='zh'){d.setAttribute('lang',t.language);}}catch(e){}})();",
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
