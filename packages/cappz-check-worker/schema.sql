-- cappz-check job log (paid-agent JobStore on D1). Append-only events; results by job and stage.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  network TEXT NOT NULL,
  job_id TEXT NOT NULL,
  type TEXT NOT NULL,
  tx_hash TEXT,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events (network, job_id, seq);
CREATE INDEX IF NOT EXISTS events_tx ON events (network, tx_hash);
CREATE TABLE IF NOT EXISTS results (
  network TEXT NOT NULL,
  job_id TEXT NOT NULL,
  stage INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (network, job_id, stage)
);
