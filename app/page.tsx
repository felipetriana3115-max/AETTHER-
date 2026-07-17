import Image from 'next/image';
import PageShell from './components/PageShell';
import DashboardBody from './components/DashboardBody';

export default function Home() {
  return (
    <PageShell title="Dashboard" subtitle="Resumen general del ERP">
      <DashboardBody />
      <Image
        src="/logo-aether.png"
        alt="Logotipo de Aether"
        width={300}
        height={100}
        priority
      />
    </PageShell>
  );
}
