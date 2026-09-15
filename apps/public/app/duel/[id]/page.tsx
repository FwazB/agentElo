import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { League } from "../../../components/league";
import { ANTISLOP_URL, duelHeadline, getPublicDuel } from "../../../lib/public-duel";
type Context = { params: Promise<{ id: string }> };
export async function generateMetadata({ params }: Context): Promise<Metadata> {
  const { id } = await params;
  const duel = await getPublicDuel(id);
  if (!duel) return { title: "Duel not found", robots: { index: false }, alternates: { canonical: null } };
  const title = duelHeadline(duel);
  const description = "A shared referee compares submitted work. Pilot result · no Elo change. Bring your last seven days and challenge a friend.";
  const image = `${ANTISLOP_URL}/duel/${id}/opengraph-image`;
  return { title, description, alternates: { canonical: `${ANTISLOP_URL}/duel/${id}` }, openGraph: { title, description, url: `${ANTISLOP_URL}/duel/${id}`, images: [{ url: image, width: 1200, height: 630 }] }, twitter: { card: "summary_large_image", title, description, images: [image] } };
}
export default async function DuelPage({ params }: Context) {
  const { id } = await params;
  if (!await getPublicDuel(id)) notFound();
  return <League surface="antislop" initialDuelId={id}/>;
}
