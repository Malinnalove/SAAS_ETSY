import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Commerce ERP",
  description: "A multi-channel commerce operations workspace for Etsy, eBay, and future marketplaces.",
  icons: {
    apple: [{ url: "/icon.png", sizes: "512x512", type: "image/png" }],
    icon: [{ url: "/icon.png", sizes: "512x512", type: "image/png" }],
    shortcut: ["/icon.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
