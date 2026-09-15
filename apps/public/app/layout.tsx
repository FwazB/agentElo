import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL("https://antislop.org"),
  title: { default: "AntiSlop — Show your work.", template: "%s · AntiSlop" },
  description: "Less slop. More proof. Bring your last seven days, challenge a friend, and meet the same referee. AI assistance welcome.",
  alternates: { canonical: "https://antislop.org" },
  openGraph: {
    type: "website",
    siteName: "AntiSlop",
    url: "https://antislop.org",
    title: "AntiSlop — Show your work.",
    description: "Bring your last seven days. Challenge a friend. Same referee.",
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "AntiSlop. Show your work. Less slop. More proof." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "AntiSlop — Show your work.",
    description: "Bring your last seven days. Challenge a friend. Same referee.",
    images: [{ url: "/opengraph-image", alt: "AntiSlop. Show your work. Less slop. More proof." }],
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><head><link rel="preload" href="/fonts/dynapuff-bold.ttf" as="font" type="font/ttf" crossOrigin="anonymous"/><link rel="preload" href="/fonts/dm-sans-regular.ttf" as="font" type="font/ttf" crossOrigin="anonymous"/></head><body><a href="#main" className="skip-link">Skip to content</a>{children}</body></html>;
}
