import {
  listOutlookLogs,
  publicOutlookConnection,
} from "../../../../lib/repository/invoice-store";

export async function GET() {
  return Response.json({
    connection: publicOutlookConnection(),
    logs: listOutlookLogs(),
  });
}
