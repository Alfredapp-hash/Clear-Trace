import { IntakeSkeleton } from "@/components/Skeletons";

/** Keeps /cases/new from flashing the case-list skeleton while it loads. */
export default function NewCaseLoading() {
  return <IntakeSkeleton />;
}
