"use client";

/**
 * 工具库 (Tool Library) — MERGED into the canonical /tools page (P3).
 *
 * The catalog presentation (side-effect badges + filters) and the API-reference
 * presentation were two separate pages over the same GET /v1/tools data. They are
 * now one page at /tools (catalog filters + full API docs + the progressive
 * doc→tool story). This route redirects so old links / bookmarks keep working.
 */

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Empty } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";

export default function ToolLibraryRedirect() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useParams<{ tenant: string }>();
  useEffect(() => {
    router.replace(`/portal/${params.tenant}/tools`);
  }, [router, params.tenant]);
  return (
    <div style={{ padding: 20 }}>
      <Empty title={t("toolLibrary.redirect.title")} hint={t("toolLibrary.redirect.hint")} />
    </div>
  );
}
