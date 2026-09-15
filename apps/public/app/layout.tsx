import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL("https://computer-elo.vercel.app"),
  title: { default: "Computer Elo — Your week. Your rating.", template: "%s · Computer Elo" },
  description: "Rate your week at the computer. Choose your username, share your Computer Form, and build your Elo. Your activity stays private.",
  openGraph: {
    type: "website",
    siteName: "Computer Elo",
    url: "https://computer-elo.vercel.app",
    title: "Computer Elo — How was your week?",
    description: "Ask your AI to rate your week. Bring back one score to share. Real evidence needed; your history stays private.",
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Computer Elo. How was your week? Ask your AI. Share your score. Your history stays private." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Computer Elo — How was your week?",
    description: "Ask your AI to rate your week. Bring back one score to share. Real evidence needed; your history stays private.",
    images: [{ url: "/opengraph-image", alt: "Computer Elo. How was your week? Ask your AI. Share your score. Your history stays private." }],
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><head><link rel="preload" href="/fonts/dynapuff-bold.ttf" as="font" type="font/ttf" crossOrigin="anonymous"/><link rel="preload" href="/fonts/dm-sans-regular.ttf" as="font" type="font/ttf" crossOrigin="anonymous"/></head><body><a href="#main" className="skip-link">Skip to content</a>{children}</body></html>;
}
