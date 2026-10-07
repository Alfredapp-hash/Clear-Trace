import { CaseDetailSkeleton } from "@/components/Skeletons";

/** Shown inside the app shell (cases/layout.tsx) while a case's data loads. */
export default function CaseLoading() {
  return <CaseDetailSkeleton />;
}
