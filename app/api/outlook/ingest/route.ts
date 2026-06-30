import {
  addAuditEvent,
  addOutlookLog,
  createUploadedInvoice,
  detectContentDuplicate,
  findDuplicateBeforeProcessing,
  getOutlookConnection,
  listInvoices,
  recomputeInvoiceState,
  requirePermission,
  setOutlookConnection,
  setOutlookConnectionNeedsReconnect,
  updateInvoiceExtraction,
} from "../../../../lib/repository/invoice-store";
import { extractInvoiceData } from "../../../../lib/services/invoice-extraction-service";
import {
  mockDetectedInvoiceEmails,
  refreshOutlookTokenIfNeeded,
} from "../../../../lib/services/outlook-service";
import { storeMockInvoiceFile } from "../../../../lib/services/storage-service";
import { createId } from "../../../../lib/utils/id";
import { logger } from "../../../../lib/utils/logger";

export async function POST() {
  try {
    requirePermission("upload");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Not allowed.";
    return Response.json({ error: message }, { status: 403 });
  }

  let connection = getOutlookConnection();

  if (!connection || connection.status !== "connected") {
    return Response.json(
      { error: "Connect the company Outlook mailbox before ingestion." },
      { status: 409 }
    );
  }

  try {
    const refreshedConnection = await refreshOutlookTokenIfNeeded(connection);
    if (refreshedConnection && refreshedConnection.updatedAt !== connection.updatedAt) {
      connection = setOutlookConnection(refreshedConnection);
      addAuditEvent({
        type: "token_refresh_success",
        message: "Outlook token refresh succeeded.",
        metadata: {
          provider: "outlook",
          connectionId: refreshedConnection.id,
          expiresAt: refreshedConnection.expiresAt,
        },
      });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Outlook token refresh failed.";
    setOutlookConnectionNeedsReconnect(connection.userId, message);
    return Response.json(
      { error: "Outlook access was revoked or expired. Reconnect Outlook." },
      { status: 409 }
    );
  }

  const detectedEmails = mockDetectedInvoiceEmails();
  const logs = [];
  const duplicates = [];

  for (const email of detectedEmails) {
    const storageKey = `outlook/${email.messageId}/${email.attachmentName}`;
    const checksum = `outlook:${email.messageId}:${email.attachmentName}:${email.attachmentSize}`;
    const duplicate = findDuplicateBeforeProcessing({
      fileName: email.attachmentName,
      fileSize: email.attachmentSize,
      checksum,
      source: "outlook",
    });

    if (duplicate) {
      duplicates.push({
        fileName: email.attachmentName,
        fileSize: email.attachmentSize,
        checksum,
        reason: duplicate.detection.message,
        duplicateInvoiceId: duplicate.duplicate.id,
        exactBookingId: duplicate.detection.candidates[0]?.exactBookingId,
        detection: duplicate.detection,
      });
      const duplicateLog = addOutlookLog({
        id: createId("outlook_log"),
        connectionId: connection.id,
        messageId: email.messageId,
        subject: email.subject,
        sender: email.sender,
        category: "INTO Needs Review",
        detectedAttachmentCount: 1,
        processedInvoiceId: duplicate.duplicate.id,
        createdAt: new Date().toISOString(),
      });
      logs.push(duplicateLog);
      continue;
    }

    const storedAttachment = storeMockInvoiceFile({
      storageKey,
      fileName: email.attachmentName,
      fileType: email.attachmentType,
      content: [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<Invoice>",
        `  <Source>Outlook attachment ${email.attachmentName}</Source>`,
        `  <MessageId>${email.messageId}</MessageId>`,
        `  <Subject>${email.subject}</Subject>`,
        `  <Sender>${email.sender}</Sender>`,
        "</Invoice>",
      ].join("\n"),
    });
    const invoice = createUploadedInvoice({
      source: "outlook",
      fileName: email.attachmentName,
      fileType: storedAttachment.fileType,
      fileSize: storedAttachment.fileSize,
      checksum,
      storageKey,
      outlookMessageId: email.messageId,
    });
    const extractedData = await extractInvoiceData({
      name: email.attachmentName,
      type: email.attachmentType,
      size: email.attachmentSize,
    });
    updateInvoiceExtraction(invoice.id, extractedData);
    addAuditEvent({
      invoiceId: invoice.id,
      type: "invoice_extracted",
      message: "Invoice data was extracted from the Outlook attachment.",
      metadata: {
        source: invoice.source,
        confidence: extractedData.confidence,
        messageId: email.messageId,
      },
    });
    const updatedInvoice = recomputeInvoiceState(invoice.id);
    addAuditEvent({
      invoiceId: invoice.id,
      type: "invoice_validated",
      message: `Invoice validation completed with ${updatedInvoice?.validationErrors.length ?? 0} issue(s).`,
      metadata: {
        status: updatedInvoice?.status,
        errorCount: updatedInvoice?.validationErrors.length ?? 0,
      },
    });
    detectContentDuplicate(invoice.id);
    const finalInvoice = recomputeInvoiceState(invoice.id) ?? updatedInvoice;
    const log = addOutlookLog({
      id: createId("outlook_log"),
      connectionId: connection.id,
      messageId: email.messageId,
      subject: email.subject,
      sender: email.sender,
      category:
        finalInvoice?.status === "Ready to Book" ? "INTOed" : "INTO Needs Review",
      detectedAttachmentCount: 1,
      processedInvoiceId: invoice.id,
      createdAt: new Date().toISOString(),
    });

    logger.info("outlook.invoice_ingested", {
      invoiceId: invoice.id,
      messageId: email.messageId,
      status: finalInvoice?.status,
    });
    logs.push(log);
  }

  addAuditEvent({
    type: "sync_operation",
    message: `Outlook invoice scan completed with ${logs.length} message(s) processed.`,
    metadata: {
      provider: "outlook",
      connectionId: connection.id,
      processedMessageCount: logs.length,
      duplicateCount: duplicates.length,
    },
  });

  return Response.json({ invoices: listInvoices(), logs, duplicates });
}
