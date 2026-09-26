CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
