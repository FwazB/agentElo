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
  const title = receipt ? `@${username} · ${receipt.form.score}/1000 Computer Form` : `@${username} · Computer Elo`;
  const description = receipt
    ? `${receipt.week_id}. Form ${receipt.form.score}/1000 · ${Math.round(receipt.form.confidence.effective_ppm / 10000)}% confidence · ${(receipt.elo.scalar.rating_milli / 1000).toFixed(3)} Elo${receipt.elo.scalar.rated_matches === 0 ? " (unrated)" : ""}. Self-attested. What’s your score?`
    : "A new player in the open computer league. Rate your week and share your score.";
  const imageUrl = `${SITE_URL}/u/${username}/opengraph-image`;
  return {
    title: receipt ? title : `@${username}`,
    description,
    alternates: { canonical: `${SITE_URL}/u/${username}` },
    openGraph: { title, description, url: `${SITE_URL}/u/${username}`, type: "profile", images: [{ url: imageUrl, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: [imageUrl] },
  };
}

export default async function UsernamePage({ params }: Context) {
  const { username } = await params;
  if (!await getPublicProfile(username)) notFound();
  return <League initialProfile={{ username }} />;
}
