"use client";

import { useEffect, useRef } from "react";
import { switchWorkspaceAction } from "@/app/(protected)/workspaces/actions";

/**
 * Selects the workspace an invitation was just accepted into (PD-9).
 *
 * Selection is the preferred-workspace cookie, which only a Server Function or
 * Route Handler may write — never a Server Component render — so the accept page
 * hands off to the sanctioned switcher: a POST server action that re-validates
 * the membership before honoring it. It is submitted once on mount, and the
 * button keeps the step available without JavaScript.
 *
 * Auto-submitting is safe here and nowhere else: this form only renders in the
 * response that consumed a single-use invitation token for this user.
 */
export function OpenInvitedWorkspace({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    formRef.current?.requestSubmit();
  }, []);

  return (
    <form ref={formRef} action={switchWorkspaceAction}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <button type="submit" className="rounded-full bg-cyan-300 px-5 py-2 text-sm font-semibold text-slate-900">
        Open {workspaceName}
      </button>
    </form>
  );
}
