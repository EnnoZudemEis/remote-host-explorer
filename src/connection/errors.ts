/** True if the error means "file or folder does not exist" (SFTP code 2, FTP 550, ENOENT, common messages). */
export function isNotFoundError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: string } | undefined;
  if (err?.code === 2 || err?.code === 550 || err?.code === 'ENOENT') return true;
  return /no such file|not found|does not exist|ENOENT/i.test(err?.message ?? '');
}
