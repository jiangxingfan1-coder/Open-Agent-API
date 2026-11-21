// Keep the worker's indexed count identical to the serving connection, without loading the gateway.
export const fileBytes = (payload: 'payload' | 'NEW.payload' | 'OLD.payload') =>
  `CASE WHEN json_valid(${payload}) THEN CASE WHEN json_type(${payload},'$.bytes')='integer' AND json_extract(${payload},'$.bytes')>=0 THEN json_extract(${payload},'$.bytes') END END`;
export const fileDigest =
  "CASE WHEN json_valid(payload) THEN CASE WHEN json_extract(payload,'$.runId') IS NULL AND json_extract(payload,'$.allowedNodes') IS NULL AND json_type(payload,'$.sha256')='text' AND length(json_extract(payload,'$.sha256'))=64 THEN json_extract(payload,'$.sha256') END END";
export const exactTotal = (value: string) => {
  // Values are nonnegative. A single unknown therefore puts the sum outside the exact
  // integer range, without two additional count aggregates on every cold catalog row.
  const sum = `total(coalesce(${value},${Number.MAX_SAFE_INTEGER + 1}))`;
  return `CASE WHEN ${sum}<=${Number.MAX_SAFE_INTEGER} THEN CAST(${sum} AS INTEGER) END`;
};
export const storedFileTotalSql = `SELECT ${exactTotal(fileBytes('payload'))} FROM main.files INDEXED BY file_upload_facts WHERE owner=:owner AND subject=:subject`;
