import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Port Intelligence Console",
  description: "Operational intelligence ledger for ports, terminals, berths, and source data with multiple observed values.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
