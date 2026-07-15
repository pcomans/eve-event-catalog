import { redirect } from "next/navigation";

export default function Home() {
  // Catalog is now the first nav item and the product pitch (task #34) —
  // a visitor landing on "/" should see what's on offer before what's
  // currently subscribed.
  redirect("/catalog");
}
