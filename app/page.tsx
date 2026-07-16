import PageShell from "./components/PageShell";
import DashboardBody from "./components/DashboardBody";
import demoClient from "../config/demoClient.json";

export default function Home() {
  return (
    <PageShell
      title="Panel"
      subtitle={`${demoClient.businessName} · ${demoClient.industry}`}
    >
      <DashboardBody />
    </PageShell>
  );
}
<Image
  src="/logo-aether.jpeg"
  alt="Logotipo de Aether"
  width={300}
  height={100}
  priority
  />
import Image from 'next/image';