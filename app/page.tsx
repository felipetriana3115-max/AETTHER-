import Image from 'next/image';
import logo from './logo-aether.png'; // Como están en la misma carpeta, esto debe funcionar
import { PageShell } from '../components/PageShell'; // Subimos una carpeta con ../
import { DashboardBody } from '../components/DashboardBody';

export default function Home() {
  return (
    <PageShell>
      <DashboardBody />
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