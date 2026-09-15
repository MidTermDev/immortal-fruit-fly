import SiteHeader from "@/components/SiteHeader";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <><SiteHeader current="docs" />{children}</>;
}
