// pg_restore exits non-zero when --clean tries to drop objects that never
// existed. That is expected on a first restore into an empty database. A restore
// that ignored any other error is not a success, even though pg_restore prints
// the same "errors ignored on restore" summary for both cases.
export function onlyMissingObjects(stderr) {
  const errors = String(stderr || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => /error/i.test(line) && !/errors ignored on restore/i.test(line));
  return errors.length > 0 && errors.every(line => /does not exist/i.test(line));
}
