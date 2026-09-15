import { League } from "../../components/league";

export const metadata = {
  title: "Connect your AI",
  description: "Give your agent the public Computer Elo scoring guide. Your activity stays private, and an assessment needs real, authorized evidence.",
};

export default function ConnectPage() {
  return <League initialDialog="connect" />;
}
