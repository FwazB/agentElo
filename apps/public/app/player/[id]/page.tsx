import { League } from "../../../components/league";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <League surface="antislop" initialProfile={{ id }} />;
}
