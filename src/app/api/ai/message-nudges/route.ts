import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { canUseAdvancedAi } from "@/lib/feature-gates";
import { runAIModule } from "@/lib/ai/gateway";
import { abuseDenyResponse, enforceAbuseLimit } from "@/lib/security/abuse-protection";
import { safeLegacyErrorResponse } from "@/lib/security/safe-route-error";

export async function GET() {
  return NextResponse.json(
    { error: "Use POST with { rawMessage, audience } for message nudges." },
    { status: 405 },
  );
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const advancedAiAccess = await canUseAdvancedAi(user.id);
  if (!advancedAiAccess.ok) {
    return NextResponse.json(
      { error: advancedAiAccess.error, feature: advancedAiAccess.feature, requiredPlan: advancedAiAccess.requiredPlan },
      { status: 402 },
    );
  }

  // See docs/security/abuse-protection-boundary.md ("ai.module_output.message_nudges").
  const abuseDecision = await enforceAbuseLimit({ scope: "ai.module_output", action: "message_nudges", identifier: user.id, limit: 60, windowSeconds: 3600 });
  if (!abuseDecision.allowed) return abuseDenyResponse(abuseDecision);

  let payload: { rawMessage?: string; audience?: string; projectId?: string };

  try {
    payload = (await request.json()) as { rawMessage?: string; audience?: string; projectId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const response = await runAIModule({
      moduleId: "message-nudges",
      input: payload,
      context: {
        projectId: payload.projectId?.trim() || "demo-project",
        actor: { actorType: "user", actorUserId: user.id },
      },
    });

    return NextResponse.json(response);
  } catch (error) {
    return safeLegacyErrorResponse("/api/ai/message-nudges", error, "Unable to process message nudges. Please retry.");
  }
}
