import "./globals.css";import type{Metadata}from"next";
export const metadata:Metadata={title:"GTA Viral Radar",description:"Radar internacional de tendências de GTA VI"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="pt-BR"><body>{children}</body></html>}
