import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Computer Elo — Your week. Your rating.", template: "%s · Computer Elo" },
  description: "Rate your week at the computer. Choose your username, share your Computer Form, and build your Elo. Your activity stays private.",
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><head><link rel="preload" href="/fonts/dynapuff-bold.ttf" as="font" type="font/ttf" crossOrigin="anonymous"/><link rel="preload" href="/fonts/dm-sans-regular.ttf" as="font" type="font/ttf" crossOrigin="anonymous"/></head><body><a href="#main" className="skip-link">Skip to content</a>{children}</body></html>;
}
