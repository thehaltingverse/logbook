CREATE TABLE IF NOT EXISTS note_marks (
  note_id TEXT NOT NULL,
  owner_sub TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (note_id, owner_sub)
);

CREATE TABLE IF NOT EXISTS note_flags (
  note_id TEXT NOT NULL PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
