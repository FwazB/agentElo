import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { League } from "../../../components/league";
import { ANTISLOP_URL, getPublicEntry } from "../../../lib/public-duel";
type Context = { params: Promise<{ id: string }> };
export async function generateMetadata({ params }: Context): Promise<Metadata> {
  const { id } = await params;
  const entry = await getPublicEntry(id);
  if (!entry) return { title: "Challenge not found", robots: { index: false }, alternates: { canonical: null } };
  const title = entry.username ? `@${entry.username} challenges you` : "Show your work. Accept the challenge.";
  const description = "Bring your last seven days. Same referee. Let's see what you shipped.";
  return { title, description, alternates: { canonical: `${ANTISLOP_URL}/challenge/${id}` }, openGraph: { title, description, url: `${ANTISLOP_URL}/challenge/${id}`, images: [{ url: `${ANTISLOP_URL}/opengraph-image`, width: 1200, height: 630 }] }, twitter: { card: "summary_large_image", title, description, images: [`${ANTISLOP_URL}/opengraph-image`] } };
}
export default async function ChallengePage({ params }: Context) {
  const { id } = await params;
  if (!await getPublicEntry(id)) notFound();
  return <League surface="antislop" initialChallengeId={id}/>;
}
