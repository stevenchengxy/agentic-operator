export function promptRequestFingerprint(body: unknown): string {
  return JSON.stringify(body);
}

export function isCurrentPromptRequest({
  requestId,
  latestRequestId,
  requestFingerprint,
  currentFingerprint,
}: {
  requestId: number;
  latestRequestId: number;
  requestFingerprint: string;
  currentFingerprint: string;
}): boolean {
  return (
    requestId === latestRequestId && requestFingerprint === currentFingerprint
  );
}
