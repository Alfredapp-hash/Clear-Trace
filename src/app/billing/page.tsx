import { Suspense } from "react";
import { BillingPageClient } from "./BillingPageClient";

export default function BillingPage() {
  return (
    <Suspense
      fallback={
        <div className="ct-ambient flex min-h-screen items-center justify-center text-sm text-slate-500">
          Loading billing…
        </div>
      }
    >
      <BillingPageClient />
    </Suspense>
  );
}