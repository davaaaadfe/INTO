import { createHash, timingSafeEqual } from "node:crypto";
import {
  cleanupTemporaryInvoiceFiles,
} from "../../../../lib/repository/invoice-store";
import { withMachinePersistentStore } from "../../../../lib/repository/persistent-request";

function hasMachineAuthorization(request: Request, configuredToken: string) {
  const match = /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;

  const expected = createHash("sha256").update(configuredToken).digest();
  const supplied = createHash("sha256").update(match[1]).digest();
  return timingSafeEqual(expected, supplied);
}

export async function POST(request: Request) {
  const configuredToken = process.env.INTO_STORAGE_CLEANUP_TOKEN?.trim() ?? "";
  if (configuredToken.length < 32) {
    return Response.json(
      { error: "Storage cleanup is not configured." },
      { status: 503 }
    );
  }
  if (!hasMachineAuthorization(request, configuredToken)) {
    return Response.json(
      { error: "Machine authentication required." },
      { status: 401 }
    );
  }

  return withMachinePersistentStore(async (context) => {
    const cleanup = await cleanupTemporaryInvoiceFiles(new Date(), context);
    return Response.json({
      cleanup: {
        checked: cleanup.checked,
        deleted: cleanup.deleted,
        learningArtifactsPruned: cleanup.learningArtifactsPruned,
      },
    });
  }, request);
}
