"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/catalog", label: "Catalog" },
  { href: "/subscriptions", label: "Subscriptions" },
  { href: "/events", label: "Event Feed" },
  { href: "/decisions", label: "Decisions" },
  { href: "/campaign", label: "Campaign" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="flex items-baseline gap-6 border-b px-6 py-4">
      <span className="text-sm font-semibold tracking-tight">Event Catalog — Observatory</span>
      <nav className="flex gap-4">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "text-sm text-muted-foreground hover:text-foreground",
              pathname === link.href && "text-foreground font-medium",
            )}
          >
            {link.label}
          </Link>
        ))}
      </nav>
      {/* Cadence now varies by page (2s poll / live stream / 60s poll), so
          the header only claims what's true everywhere: read-only. */}
      <span className="ml-auto text-xs text-muted-foreground">read-only</span>
    </header>
  );
}
