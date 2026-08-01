import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { DashboardProvider } from "./components/DashboardProvider";
import GlobalToast from "./components/GlobalToast";
import ServiceWorkerRegister from "./components/ServiceWorkerRegister";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: 'Aether ERP | Potencia tu negocio',
  description: 'Sistema ERP para la gestión inteligente de tu empresa.',
  // Habilita el arranque en pantalla completa al instalar en iOS.
  appleWebApp: {
    capable: true,
    title: 'Aether POS',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  themeColor: '#7c3aed',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <DashboardProvider>
          {children}
          <GlobalToast />
        </DashboardProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
