"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { CardSkeleton } from "@/shared/components/Loading";
import SegmentedControl from "@/shared/components/SegmentedControl";
import ProviderLimits from "../usage/components/ProviderLimits";
import KeyQuotaView from "./components/KeyQuotaView";

const TABS = [
  { value: "providers", label: "Provider Limits" },
  { value: "keys", label: "API Key Quotas" },
];

export default function QuotaPage({ tab: propTab } = {}) {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <QuotaContent propTab={propTab} />
    </Suspense>
  );
}

function QuotaContent({ propTab }) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const tabParam = propTab || searchParams?.get("tab");
  const [localTab, setLocalTab] = useState(
    tabParam === "keys" || tabParam === "key-quotas" ? "keys" : "providers"
  );

  const activeTab = propTab || (tabParam === "keys" || tabParam === "key-quotas"
    ? "keys"
    : tabParam === "providers"
    ? "providers"
    : localTab);

  const handleTabChange = (val) => {
    setLocalTab(val);
    if (router && searchParams) {
      const nextParams = new URLSearchParams(searchParams.toString());
      nextParams.set("tab", val);
      router.push(`/dashboard/quota?${nextParams.toString()}`, { scroll: false });
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0" data-testid="quota-page">
      <div className="flex items-center justify-between">
        <div data-testid="quota-tabs" className="w-full sm:w-auto">
          <SegmentedControl
            options={TABS}
            value={activeTab}
            onChange={handleTabChange}
            className="w-full sm:w-auto"
          />
        </div>
      </div>

      {activeTab === "keys" ? (
        <div data-testid="key-quota-view">
          <Suspense fallback={<CardSkeleton />}>
            <KeyQuotaView />
          </Suspense>
        </div>
      ) : (
        <div data-testid="provider-limits-view">
          <Suspense fallback={<CardSkeleton />}>
            <ProviderLimits />
          </Suspense>
        </div>
      )}
    </div>
  );
}
