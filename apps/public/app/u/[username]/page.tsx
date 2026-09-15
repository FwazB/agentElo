import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { League } from "../../../components/league";
import { getPublicProfile, SITE_URL } from "../../../lib/public-profile";

type Context = { params: Promise<{ username: string }> };

export async function generateMetadata({ params }: Context): Promise<Metadata> {
  const { username } = await params;
  const profile = await getPublicProfile(username);
  if (!profile) return { title: "Player not found", robots: { index: false } };
  const receipt = profile.player.receipt;
  const title = receipt ? `@${username} · ${receipt.form.score}/1000 · AntiSlop` : `@${username} · AntiSlop`;
  const description = receipt
    ? `My AI rated me with a ${receipt.form.score}/1000. What’s your Elo?`
    : "Bring your work. Get your score. What’s your Elo?";
  const imageUrl = `${SITE_URL}/u/${username}/opengraph-image`;
  const imageAlt = receipt ? `@${username}: Computer Form ${receipt.form.score}/1000 and Elo ${Math.round(receipt.elo.scalar.rating_milli / 1000)}. AntiSlop. What’s your Elo?` : `@${username} on AntiSlop. No Form score yet. What’s your Elo?`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: `${SITE_URL}/u/${username}` },
    openGraph: { title, description, url: `${SITE_URL}/u/${username}`, type: "profile", images: [{ url: imageUrl, width: 1200, height: 630, alt: imageAlt }] },
    twitter: { card: "summary_large_image", title, description, images: [{ url: imageUrl, alt: imageAlt }] },
  };
}

export default async function UsernamePage({ params }: Context) {
  const { username } = await params;
  if (!await getPublicProfile(username)) notFound();
  return <League surface="antislop" initialProfile={{ username }} />;
}
