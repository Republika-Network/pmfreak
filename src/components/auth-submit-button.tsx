"use client";

import { useFormStatus } from "react-dom";
import { authButtonClass } from "@/ui-core/forms/auth-button";

type AuthSubmitButtonProps = {
  idleLabel: string;
  pendingLabel: string;
};

export default function AuthSubmitButton({
  idleLabel,
  pendingLabel,
}: AuthSubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className={authButtonClass}
    >
      {pending ? pendingLabel : idleLabel}
    </button>
  );
}
