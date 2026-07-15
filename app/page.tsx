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
