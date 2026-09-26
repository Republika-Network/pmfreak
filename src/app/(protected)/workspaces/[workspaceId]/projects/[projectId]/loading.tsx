/**
 * The project's loading state — shaped like the conversation it is about to
 * become (CHAT-SHELL-01): a header, an empty transcript and the composer, so the
 * page does not jump from a dashboard skeleton into a conversation.
 */
export default function ProjectDetailLoading() {
  return (
    <div className="flex h-full min-h-[60vh] flex-col" aria-busy="true" aria-label="Loading project">
      <div className="flex h-[57px] shrink-0 items-center gap-3 border-b border-slate-200 px-5">
        <div className="h-4 w-48 animate-pulse rounded bg-slate-100" />
      </div>
      <div className="flex-1" />
      <div className="mx-auto w-full max-w-3xl px-4 pb-6 sm:px-6">
        <div className="h-[88px] animate-pulse rounded-2xl border border-slate-200 bg-slate-50" />
      </div>
    </div>
  );
}
