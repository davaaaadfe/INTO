import { IntoVerificationScreen } from "../../components/into-verification-screen";

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = "" } = await searchParams;
  return <IntoVerificationScreen token={token} />;
}
