import PageShell from "./components/PageShell";
import DashboardBody from "./components/DashboardBody";
import GlobalToast from "./components/GlobalToast";
import { DashboardProvider } from "./components/DashboardProvider";

export default function Home() {
  return (
    <DashboardProvider>
      <PageShell
        title="Panel"
        subtitle="Repostería artesanal · Visión general del negocio"
      >
        <DashboardBody />
      </PageShell>
      <GlobalToast />
    </DashboardProvider>
  );
}
