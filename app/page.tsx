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
import Image from 'next/image';
import logo from './logo-aether.png';

export default function Home() {
  return (
    <PageShell>
      <DashboardBody />
      {/* Tu imagen ahora está dentro del componente correctamente */}
      <Image 
        src={logo} 
        alt="Logotipo de Aether" 
        width={300} 
        height={100} 
        priority 
      />
    </PageShell>
  );
}